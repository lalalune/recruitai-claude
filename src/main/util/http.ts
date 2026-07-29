/**
 * Polite HTTP client for public endpoints.
 *
 * Two rules encoded here, both deliberate:
 *
 *  1. On 429/403 we stop. The one exception is a 429 carrying a small
 *     Retry-After (≤30s): that is the host telling us how to be polite, so we
 *     wait exactly that long and try once more while retries remain. A 403, a
 *     bare 429, or a long Retry-After is terminal for the source. We never
 *     rotate proxies or otherwise work around a deliberate block. Reading
 *     public data briskly is defensible; circumventing a block is a different
 *     thing and would turn an operational annoyance into a legal argument.
 *
 *  2. The User-Agent is truthful and carries a contact URL, so anyone who
 *     notices the traffic can reach us.
 */

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Bytes. Guards against a 30 MB board response blowing up memory. */
  maxBytes?: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  fetchedAt: string;
  /** Set when the host asked us to stop. Callers must treat this as terminal. */
  blocked?: boolean;
  error?: string;
}

export const USER_AGENT =
  'recruitAI/0.1 (+https://github.com/lalalune/recruitai-claude; local research tool)';

/**
 * Hosts the crawler must never be redirected onto.
 *
 * Company websites are attacker-controlled from our point of view, and the
 * crawler follows their redirects. A site that 302s to http://127.0.0.1:11434/
 * or to link-local metadata would have its response body regex-scanned and
 * stored in raw_response, where the evidence viewer renders it. Nothing we
 * legitimately fetch lives on a private network, so refusing is free.
 */
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?fc|\[?fd|\[?fe80)/i;

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  return PRIVATE_HOST_RE.test(hostname.toLowerCase());
}

/** Max hops before we call it a loop. Matches the fetch default. */
const MAX_REDIRECTS = 5;

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

export class BlockedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Blocked by host (${status}): ${url}`);
    this.name = 'BlockedError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full jitter, capped. Avoids synchronised retry storms across concurrent workers. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.floor(Math.random() * base);
}

/** The longest Retry-After we will honour. Beyond this the host is effectively
 *  saying "come back much later", which for a single sweep means: stop. */
const RETRY_AFTER_MAX_S = 30;

/**
 * A Retry-After we are willing to honour: a plain non-negative number of
 * seconds, no larger than RETRY_AFTER_MAX_S. The HTTP-date form (and anything
 * longer than the cap) reads as a long ban and yields null — terminal.
 */
function politeRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const t = header.trim();
  // Number('') is 0 — an empty header would otherwise read as "retry now".
  if (!t) return null;
  const s = Number(t);
  if (!Number.isFinite(s) || s < 0 || s > RETRY_AFTER_MAX_S) return null;
  return Math.round(s * 1000);
}

/** Release the connection on paths that never read the body. An abandoned
 *  undici body pins its pooled connection until GC gets around to it. */
function discardBody(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

export async function httpRequest(
  url: string,
  opts: HttpOptions = {},
): Promise<HttpResponse> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT,
    maxRetries = 2,
    maxBytes = DEFAULT_MAX_BYTES,
  } = opts;

  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    // The timer covers the WHOLE attempt, headers and body. Clearing it when
    // headers arrived (as this once did) let a slow-dripping body hold a
    // worker far past timeoutMs.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Manual redirect following: 'follow' would hand us the final body with
      // no chance to inspect the hops. See isPrivateHost.
      let current = url;
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        if (isPrivateHost(new URL(current).hostname)) {
          clearTimeout(timer);
          return {
            ok: false,
            status: 0,
            body: '',
            url,
            fetchedAt: new Date().toISOString(),
            error: `Refused to fetch a private/loopback address (${new URL(current).hostname}).`,
          };
        }
        res = await fetch(current, {
          method,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9', ...headers },
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) break;
        if (hop >= MAX_REDIRECTS) {
          clearTimeout(timer);
          return {
            ok: false, status: res.status, body: '', url,
            fetchedAt: new Date().toISOString(),
            error: `Too many redirects (>${MAX_REDIRECTS}).`,
          };
        }
        current = new URL(location, current).toString();
      }

      const fetchedAt = new Date().toISOString();

      if (res.status === 429 || res.status === 403) {
        discardBody(res);
        // A 429 with a small Retry-After is a pacing instruction, not a ban —
        // honouring it is the polite move. Everything else in this branch is
        // the host telling us to stop: do not retry, do not evade.
        const waitMs = res.status === 429 ? politeRetryAfterMs(res.headers.get('retry-after')) : null;
        if (waitMs != null && attempt < maxRetries) {
          lastError = `HTTP ${res.status}`;
          await sleep(waitMs);
          continue;
        }
        return {
          ok: false,
          status: res.status,
          body: '',
          url,
          fetchedAt,
          blocked: true,
          error: `Host returned ${res.status} — backing off and stopping this source.`,
        };
      }

      // Transient server-side: worth one more try.
      if (res.status >= 500 && attempt < maxRetries) {
        discardBody(res);
        lastError = `HTTP ${res.status}`;
        await sleep(backoffMs(attempt));
        continue;
      }

      const text = await readCapped(res, maxBytes, controller.signal);
      return { ok: res.ok, status: res.status, body: text, url, fetchedAt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: 0,
    body: '',
    url,
    fetchedAt: new Date().toISOString(),
    error: lastError || 'request failed',
  };
}

async function readCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  // The fetch signal does not reliably propagate into an in-flight body read,
  // so each read is raced against it explicitly — this is what makes timeoutMs
  // a bound on the whole attempt rather than just on the headers.
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        const bail = () => reject(new Error('Body read aborted: request timeout'));
        if (signal.aborted) bail();
        else signal.addEventListener('abort', bail, { once: true });
      })
    : null;

  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = aborted
        ? await Promise.race([reader.read(), aborted])
        : await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new Error(`Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder().decode(merged);
  } catch (err) {
    // Over-cap, timeout, or a mid-body transport failure: release the
    // connection rather than leaving a half-read body pinning it.
    void reader.cancel().catch(() => {});
    throw err;
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  const res = await httpRequest(url, opts);
  if (!res.ok || !res.body) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

/**
 * Bounded-concurrency map with per-task jitter.
 *
 * Concurrency defaults to 10 deliberately. Measured burst tests showed the ATS
 * hosts tolerate 15-20, but they owe us nothing and a source going offline
 * mid-run is far more expensive than the run taking longer.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: { jitterMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<(R | null)[]> {
  const { jitterMs = 120, onProgress } = opts;
  const results: (R | null)[] = Array.from({ length: items.length }, () => null);
  let cursor = 0;
  let done = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      if (jitterMs > 0) await sleep(Math.random() * jitterMs);
      try {
        results[i] = await fn(items[i]!, i);
      } catch {
        results[i] = null;
      }
      onProgress?.(++done, items.length);
    }
  });

  await Promise.all(workers);
  return results;
}
