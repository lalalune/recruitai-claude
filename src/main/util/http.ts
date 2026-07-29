/**
 * Polite HTTP client for public endpoints.
 *
 * Two rules encoded here, both deliberate:
 *
 *  1. On 429/403 we back off and ultimately stop. We do not rotate proxies or
 *     otherwise work around a deliberate block. Reading public data briskly is
 *     defensible; circumventing a block is a different thing and would turn an
 *     operational annoyance into a legal argument.
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9', ...headers },
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      const fetchedAt = new Date().toISOString();

      // Terminal: the host is telling us to stop. Do not retry, do not evade.
      if (res.status === 429 || res.status === 403) {
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
        lastError = `HTTP ${res.status}`;
        await sleep(backoffMs(attempt));
        continue;
      }

      const text = await readCapped(res, maxBytes);
      return { ok: res.ok, status: res.status, body: text, url, fetchedAt };
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
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

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel();
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
  const results = new Array<R | null>(items.length).fill(null);
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
