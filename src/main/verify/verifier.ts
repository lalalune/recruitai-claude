/**
 * The paid verification layer.
 *
 * Three rules are structural here rather than conventional:
 *
 *  1. Every paid call writes an `api_call` row BEFORE the HTTP request, keyed by
 *     UNIQUE(provider, idempotency_key) where the key is the normalised
 *     address. A retry loop cannot double-charge because the second INSERT
 *     simply loses. Deliberate re-verification by the operator is still
 *     possible — it allocates a NEW key (`email#2`) so the extra charge is
 *     visible in the ledger as its own line rather than hidden.
 *  2. The free prefilter in mx.ts runs first, always. Malformed, disposable,
 *     role and no-MX addresses never reach a provider.
 *  3. A 429 or 403 stops the run. No proxy rotation, no retry-to-evade.
 *
 * Provider selection: 'reoon' is the default recommendation on verified
 * pricing (10k credits for $11.90, credits never expire). 'bouncer' has an $8
 * minimum for 1,000 non-expiring credits and does not charge for duplicates or
 * unknowns. 'millionverifier' is ~$37/10k, non-expiring, and refunds
 * catch-alls because it declines to verify them.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { VerificationVerdict } from '../../shared/types.js';
import { type Db, get, prep, run } from '../db/index.js';
import { httpRequest, mapLimit, type HttpResponse } from '../util/http.js';
import { SECRET_VERIFIER, getSetting, getSpendCapUsd, getVerifierProvider, readSecret } from '../settings.js';
import { prefilter, canonicalizeForCache, normalizeEmail, domainOf, saveCatchAllFlag, type MxProvider } from './mx.js';

export type VerifierProvider = 'reoon' | 'bouncer' | 'millionverifier' | 'none';

export interface VerifyResult {
  email: string;
  verdict: VerificationVerdict;
  /** Domain accepts everything; a 'valid' here means very little. */
  catchAll: boolean | null;
  role: boolean;
  disposable: boolean;
  free: boolean;
  provider: VerifierProvider | 'local';
  mxProvider: MxProvider;
  /** Why this verdict, in operator-readable words. */
  reason: string;
  /** raw_response.id holding the provider's answer, when one was paid for. */
  evidenceId: number | null;
  costMicros: number;
  verifiedAt: number;
  /** True when this came from cache or the free prefilter — no credit spent. */
  cached: boolean;
  /** Set when the provider told us to stop. Terminal for the whole run. */
  blocked?: boolean;
}

export interface VerifierConfig {
  provider: VerifierProvider;
  apiKey: string;
  /** Re-verify anything older than this. */
  freshnessDays: number;
  /** Global spend ceiling, micro-USD. */
  spendCapMicros: number;
}

export interface VerifyOptions {
  entityType?: string;
  entityId?: string;
  /** Operator-initiated re-verify. Allocates a new ledger key and may charge. */
  force?: boolean;
  /**
   * The address was observed from a real source rather than generated. Role
   * accounts are only ever paid for when this is true — a guessed role address
   * is worthless, an observed one may be the only way in.
   */
  observed?: boolean;
  config?: VerifierConfig;
}

export class SpendCapError extends Error {
  constructor(
    readonly provider: string,
    readonly spentMicros: number,
    readonly capMicros: number,
  ) {
    super(
      `Spend cap reached for ${provider}: $${(spentMicros / 1e6).toFixed(2)} of $${(capMicros / 1e6).toFixed(2)}. ` +
        `Raise the cap in Settings to continue.`,
    );
    this.name = 'SpendCapError';
  }
}

export class ProviderBlockedError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} returned ${status} — stopping verification. Not retrying, not rotating.`);
    this.name = 'ProviderBlockedError';
  }
}

/** Micro-USD per verified address, from the verified public pricing above. */
export const COST_MICROS: Record<VerifierProvider, number> = {
  reoon: 1190, // 10,000 for $11.90
  bouncer: 8000, // 1,000 for the $8 minimum
  millionverifier: 3700, // ~10,000 for $37
  none: 0,
};

const DEFAULT_FRESHNESS_DAYS = 183; // six months
const DEFAULT_SPEND_CAP_USD = 100; // matches settings.ts DEFAULT_SETTINGS.spendCapUsd
const EVIDENCE_SOURCE = 'verifier';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Config comes from settings.ts, which owns the `setting` table's encoding, and
 * from the secret store, which owns safeStorage. Env vars override both so the
 * pipeline can be exercised headlessly without touching the operator's keychain.
 */
export async function loadVerifierConfig(_db?: Db): Promise<VerifierConfig> {
  const envProvider = process.env.RECRUITAI_VERIFIER_PROVIDER;
  const envKey = process.env.RECRUITAI_VERIFIER_KEY;

  const provider = normalizeProvider(envProvider ?? getVerifierProvider());
  const apiKey = (envKey ?? (await readSecret(SECRET_VERIFIER)) ?? '').trim();

  const freshnessDays = clampNumber(
    getSetting<number>('verify.freshnessDays', DEFAULT_FRESHNESS_DAYS),
    1,
    3650,
    DEFAULT_FRESHNESS_DAYS,
  );
  const capUsd = clampNumber(getSpendCapUsd(), 0, 1_000_000, DEFAULT_SPEND_CAP_USD);

  return {
    provider,
    apiKey,
    freshnessDays,
    spendCapMicros: Math.round(capUsd * 1e6),
  };
}

function normalizeProvider(v: string): VerifierProvider {
  const s = v.trim().toLowerCase();
  return s === 'reoon' || s === 'bouncer' || s === 'millionverifier' ? s : 'none';
}

function clampNumber(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend cap
// ─────────────────────────────────────────────────────────────────────────────

export interface SpendState {
  provider: string;
  spentMicros: number;
  capMicros: number;
}

/**
 * settings.ts mirrors the operator's global cap into the row keyed 'all', so
 * the guard and the record of the spend live in the same table. Per-provider
 * rows accumulate spend; the 'all' row carries the ceiling.
 */
export const GLOBAL_CAP_PROVIDER = 'all';

export function syncSpendCap(db: Db, provider: string, capMicros: number): SpendState {
  run(
    db,
    `INSERT INTO spend_cap (provider, cap_usd_micros, spent_usd_micros)
     VALUES (?, ?, 0)
     ON CONFLICT(provider) DO NOTHING`,
    provider,
    capMicros,
  );
  run(
    db,
    `INSERT INTO spend_cap (provider, cap_usd_micros, spent_usd_micros)
     VALUES (?, ?, 0)
     ON CONFLICT(provider) DO UPDATE SET cap_usd_micros = excluded.cap_usd_micros`,
    GLOBAL_CAP_PROVIDER,
    capMicros,
  );
  const row = get<{ cap_usd_micros: number; spent_usd_micros: number }>(
    db,
    'SELECT cap_usd_micros, spent_usd_micros FROM spend_cap WHERE provider = ?',
    provider,
  )!;
  return { provider, spentMicros: row.spent_usd_micros, capMicros };
}

/** Every provider's spend, excluding the ceiling-only 'all' row. */
export function totalSpentMicros(db: Db): number {
  return (
    get<{ n: number }>(
      db,
      'SELECT coalesce(sum(spent_usd_micros), 0) AS n FROM spend_cap WHERE provider <> ?',
      GLOBAL_CAP_PROVIDER,
    )?.n ?? 0
  );
}

/**
 * Money that is committed to but not yet recorded as spent: rows sitting in
 * 'reserved'. spend_cap only moves after a call returns, so without this a
 * crash between reserve and commit — or a second verify run that interleaves at
 * an await — sees a cap that has quietly forgotten about credits already in
 * flight, and the ceiling can be walked straight past. Counting reservations is
 * what makes the cap hold across both a restart and a concurrent run.
 */
export function outstandingReservedMicros(db: Db): number {
  return (
    get<{ n: number }>(
      db,
      `SELECT coalesce(sum(est_cost_micros), 0) AS n FROM api_call WHERE state = 'reserved'`,
    )?.n ?? 0
  );
}

/** Throws rather than returning false — spending money must not be a soft path. */
export function assertSpendAvailable(db: Db, provider: string, needMicros: number, capMicros: number): void {
  syncSpendCap(db, provider, capMicros);
  const total = totalSpentMicros(db) + outstandingReservedMicros(db);
  if (total + needMicros > capMicros) {
    throw new SpendCapError(provider, total, capMicros);
  }
}

function recordSpend(db: Db, provider: string, micros: number): void {
  if (micros <= 0) return;
  run(
    db,
    'UPDATE spend_cap SET spent_usd_micros = spent_usd_micros + ? WHERE provider = ?',
    micros,
    provider,
  );
}

export function spendSummary(db: Db): SpendState[] {
  return (
    prep(db, 'SELECT provider, cap_usd_micros, spent_usd_micros FROM spend_cap').all() as {
      provider: string;
      cap_usd_micros: number;
      spent_usd_micros: number;
    }[]
  ).map((r) => ({ provider: r.provider, capMicros: r.cap_usd_micros, spentMicros: r.spent_usd_micros }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger — reserve then commit
// ─────────────────────────────────────────────────────────────────────────────

interface ApiCallRow {
  id: number;
  state: string;
  http_status: number | null;
  actual_cost_micros: number | null;
  started_at: number;
}

const API_CALL_COLUMNS = 'id, state, http_status, actual_cost_micros, started_at';

interface Reservation {
  id: number | null;
  /** Set when an existing row blocks a fresh call. */
  blockedBy: ApiCallRow | null;
  key: string;
}

/**
 * A previous attempt that provably consumed no credit may reuse its own ledger
 * row rather than forcing the operator to pay for a new key.
 *
 * Two independent proofs, either of which is enough:
 *
 *  1. The attempt recorded a zero actual cost. Every adapter reports exactly
 *     which addresses the provider metered (`chargedEmails`), and commit writes
 *     that through, so a committed 0 is a positive statement that no credit
 *     moved. This is the case that matters in practice: providers answer
 *     "invalid API key", "unparseable body" and "no task id" with HTTP 200 and
 *     an error field, and judging those by status alone locked the address out
 *     of verification forever — one bad key poisoned every address it touched.
 *  2. Failing that (a legacy row with no cost recorded), the status is outside
 *     2xx. Providers meter when they return an answer, so a network failure, a
 *     timeout, a 5xx or a 429 never reached the meter. Phrasing it as "only a
 *     2xx may have been charged" is safer than enumerating failure codes: an
 *     unanticipated status falls on the retryable side only when it is outside
 *     the success range.
 */
function noCreditConsumed(row: ApiCallRow): boolean {
  if (row.state !== 'failed') return false;
  if (row.actual_cost_micros === 0) return true;
  const s = row.http_status;
  return s == null || s < 200 || s >= 300;
}

function reserveApiCall(
  db: Db,
  args: {
    provider: string;
    endpoint: string;
    key: string;
    entityType?: string;
    entityId?: string;
    estCostMicros: number;
  },
): Reservation {
  const inserted = prep(
    db,
    `INSERT INTO api_call (provider, endpoint, idempotency_key, entity_type, entity_id, state, est_cost_micros)
     VALUES (?, ?, ?, ?, ?, 'reserved', ?)
     ON CONFLICT (provider, idempotency_key) DO NOTHING
     RETURNING id`,
  ).get(
    args.provider,
    args.endpoint,
    args.key,
    args.entityType ?? null,
    args.entityId ?? null,
    args.estCostMicros,
  ) as { id: number } | undefined;

  if (inserted) return { id: inserted.id, blockedBy: null, key: args.key };

  const existing = get<ApiCallRow>(
    db,
    `SELECT ${API_CALL_COLUMNS} FROM api_call WHERE provider = ? AND idempotency_key = ?`,
    args.provider,
    args.key,
  );
  if (!existing) return { id: null, blockedBy: null, key: args.key };

  if (noCreditConsumed(existing)) {
    run(
      db,
      `UPDATE api_call SET state = 'reserved', error = NULL, http_status = NULL,
              actual_cost_micros = NULL,
              started_at = unixepoch('subsec')*1000, finished_at = NULL
        WHERE id = ?`,
      existing.id,
    );
    return { id: existing.id, blockedBy: null, key: args.key };
  }

  return { id: null, blockedBy: existing, key: args.key };
}

function commitApiCall(
  db: Db,
  id: number,
  outcome: { state: 'succeeded' | 'failed'; httpStatus: number | null; costMicros: number; error?: string },
): void {
  run(
    db,
    `UPDATE api_call
        SET state = ?, http_status = ?, actual_cost_micros = ?, error = ?,
            finished_at = unixepoch('subsec')*1000
      WHERE id = ?`,
    outcome.state,
    outcome.httpStatus,
    outcome.costMicros,
    outcome.error ?? null,
    id,
  );
}

/**
 * The operator asking to re-verify is a deliberate purchase, so it gets its own
 * ledger key. Automatic paths collide with the base key inside a freshness
 * window, which is the double-charge protection — but once the latest
 * SUCCEEDED verification is older than the freshness window, the policy that
 * queued the address for re-verification also authorises paying for it, so a
 * fresh key is allocated. Without this, re-verification after staleness
 * collided forever and fabricated 'unknown' verdicts over valid ones.
 */
/** `_` and `%` are LIKE wildcards and `_` is common in real addresses — escape,
 *  or john_smith's ledger reads john.smith's history. */
function likePrefix(email: string): string {
  return `${email.replace(/([%_\\])/g, '\\$1')}#%`;
}

function idempotencyKeyFor(db: Db, provider: string, email: string, force: boolean, freshnessMs: number): string {
  const nextKey = () => {
    const n =
      get<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM api_call WHERE provider = ? AND (idempotency_key = ? OR idempotency_key LIKE ? ESCAPE '\\')`,
        provider,
        email,
        likePrefix(email),
      )?.n ?? 0;
    return `${email}#${n + 1}`;
  };

  if (force) return nextKey();

  const latest = get<{ idempotency_key: string; state: string; finished_at: number | null }>(
    db,
    `SELECT idempotency_key, state, finished_at FROM api_call
      WHERE provider = ? AND (idempotency_key = ? OR idempotency_key LIKE ? ESCAPE '\\')
      ORDER BY id DESC LIMIT 1`,
    provider,
    email,
    likePrefix(email),
  );
  if (!latest) return email;

  // A failed or stuck-reserved latest attempt must be retried under ITS OWN
  // key: reserveApiCall's reuse/stale-reservation logic targets that row.
  // Falling back to the base key here collided with the old SUCCEEDED base
  // row and fabricated 'unknown' forever after one failed re-verification.
  if (latest.state !== 'succeeded') return latest.idempotency_key;

  const stale = latest.finished_at != null && Date.now() - latest.finished_at > freshnessMs;
  // Fresh success → collide with THAT row (normally unreachable: fresh
  // evidence cache-hits before keying), never with an older base row.
  return stale ? nextKey() : latest.idempotency_key;
}

/** Exposed for tests: key-allocation is where double-charge protection lives. */
export const __idempotencyKeyForTests = idempotencyKeyFor;
/** Exposed for tests: so is reserve/commit, which is what survives a crash. */
export const __reserveApiCallForTests = reserveApiCall;
export const __commitApiCallForTests = commitApiCall;

// ─────────────────────────────────────────────────────────────────────────────
// Evidence + cache
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceEnvelope {
  provider: VerifierProvider;
  email: string;
  httpStatus: number;
  requestedAt: number;
  normalized: {
    verdict: VerificationVerdict;
    catchAll: boolean | null;
    role: boolean;
    disposable: boolean;
    free: boolean;
    reason: string;
  };
  raw: unknown;
}

function evidenceUrl(provider: VerifierProvider, email: string): string {
  return `verify://${provider}/${email}`;
}

function storeEvidence(db: Db, env: EvidenceEnvelope, costMicros: number): number {
  const json = JSON.stringify(env);
  const sha = createHash('sha256').update(json).digest('hex');
  const body = gzipSync(Buffer.from(json, 'utf8'));
  const row = prep(
    db,
    `INSERT INTO raw_response (sha256, source, url, status_code, encoding, body, bytes_raw, bytes_stored, cost_usd_micros)
     VALUES (?, ?, ?, ?, 'gzip', ?, ?, ?, ?)
     ON CONFLICT (sha256) DO UPDATE SET fetched_at = unixepoch('subsec')*1000
     RETURNING id`,
  ).get(
    sha,
    EVIDENCE_SOURCE,
    evidenceUrl(env.provider, env.email),
    env.httpStatus,
    body,
    Buffer.byteLength(json),
    body.byteLength,
    costMicros,
  ) as { id: number };
  return row.id;
}

/**
 * Cache lookup. Filtered on source first so it rides the (source, fetched_at)
 * index rather than scanning every stored document; the verifier partition is
 * small (one row per address ever verified) and this keeps the promise that no
 * address is ever paid for twice.
 */
function cachedEvidence(
  db: Db,
  provider: VerifierProvider,
  email: string,
  maxAgeMs: number,
): { env: EvidenceEnvelope; id: number; fetchedAt: number } | null {
  const row = get<{ id: number; body: Uint8Array | null; encoding: string; fetched_at: number }>(
    db,
    `SELECT id, body, encoding, fetched_at
       FROM raw_response
      WHERE source = ? AND url = ?
      ORDER BY fetched_at DESC
      LIMIT 1`,
    EVIDENCE_SOURCE,
    evidenceUrl(provider, email),
  );
  if (!row?.body) return null;
  if (Date.now() - row.fetched_at > maxAgeMs) return null;
  try {
    const json =
      row.encoding === 'gzip'
        ? gunzipSync(Buffer.from(row.body)).toString('utf8')
        : Buffer.from(row.body).toString('utf8');
    return { env: JSON.parse(json) as EvidenceEnvelope, id: row.id, fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapters
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderAnswer {
  verdict: VerificationVerdict;
  catchAll: boolean | null;
  role: boolean;
  disposable: boolean;
  free: boolean;
  reason: string;
  raw: unknown;
}

interface ProviderCallResult {
  answers: Map<string, ProviderAnswer>;
  httpStatus: number;
  error?: string;
  blocked?: boolean;
  /** Addresses the provider actually metered. */
  chargedEmails: string[];
}

interface ProviderAdapter {
  id: VerifierProvider;
  /** Max addresses in one request. 1 means no batch support. */
  batchSize: number;
  verify(apiKey: string, emails: string[]): Promise<ProviderCallResult>;
  testKey(apiKey: string): Promise<{ ok: boolean; message: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Paid calls never auto-retry: a retried request that already succeeded bills twice. */
const PAID_HTTP = { maxRetries: 0, timeoutMs: 30_000 } as const;

function blockedResult(res: HttpResponse, emails: string[]): ProviderCallResult {
  return {
    answers: new Map(emails.map((e) => [e, unknownAnswer(`Provider returned ${res.status}`)])),
    httpStatus: res.status,
    error: res.error ?? `HTTP ${res.status}`,
    blocked: true,
    chargedEmails: [],
  };
}

function unknownAnswer(reason: string): ProviderAnswer {
  return { verdict: 'unknown', catchAll: null, role: false, disposable: false, free: false, reason, raw: null };
}

// ── Reoon ────────────────────────────────────────────────────────────────────

interface ReoonSingle {
  email?: string;
  status?: string;
  is_safe_to_send?: boolean;
  is_disposable?: boolean;
  is_role_account?: boolean;
  is_catch_all?: boolean;
  is_free_email?: boolean;
  mx_accepted?: boolean;
  overall_score?: number;
  reason?: string;
  error?: string;
}

function normalizeReoon(r: ReoonSingle): ProviderAnswer {
  const status = (r.status ?? '').toLowerCase();
  const catchAll = r.is_catch_all ?? (status === 'catch_all' ? true : null);
  let verdict: VerificationVerdict;
  switch (status) {
    case 'valid':
    case 'safe':
      verdict = 'valid';
      break;
    case 'invalid':
    case 'spamtrap':
      verdict = 'invalid';
      break;
    case 'disposable':
      verdict = 'disposable';
      break;
    case 'catch_all':
      verdict = 'catch_all';
      break;
    default:
      verdict = 'unknown';
  }
  if (verdict === 'valid' && catchAll === true) verdict = 'catch_all';
  return {
    verdict,
    catchAll,
    role: r.is_role_account === true,
    disposable: r.is_disposable === true || status === 'disposable',
    free: r.is_free_email === true,
    reason: r.reason ?? `reoon: ${status || 'no status'}`,
    raw: r,
  };
}

const reoon: ProviderAdapter = {
  id: 'reoon',
  batchSize: 500,
  async verify(apiKey, emails) {
    if (emails.length === 1) {
      const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(emails[0]!)}&key=${encodeURIComponent(apiKey)}&mode=power`;
      const res = await httpRequest(url, PAID_HTTP);
      if (res.blocked) return blockedResult(res, emails);
      if (!res.ok) {
        return {
          answers: new Map([[emails[0]!, unknownAnswer(`reoon HTTP ${res.status}`)]]),
          httpStatus: res.status,
          error: res.error ?? `HTTP ${res.status}`,
          chargedEmails: [],
        };
      }
      let parsed: ReoonSingle;
      try {
        parsed = JSON.parse(res.body) as ReoonSingle;
      } catch {
        return {
          answers: new Map([[emails[0]!, unknownAnswer('reoon: unparseable response')]]),
          httpStatus: res.status,
          error: 'unparseable response',
          chargedEmails: [],
        };
      }
      if (parsed.error) {
        return {
          answers: new Map([[emails[0]!, unknownAnswer(`reoon: ${parsed.error}`)]]),
          httpStatus: res.status,
          error: parsed.error,
          chargedEmails: [],
        };
      }
      return {
        answers: new Map([[emails[0]!, normalizeReoon(parsed)]]),
        httpStatus: res.status,
        chargedEmails: [emails[0]!],
      };
    }

    const create = await httpRequest('https://emailverifier.reoon.com/api/v1/create-bulk-verification-task/', {
      ...PAID_HTTP,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `recruitAI-${Date.now()}`, emails, key: apiKey }),
    });
    if (create.blocked) return blockedResult(create, emails);
    if (!create.ok) {
      return {
        answers: new Map(emails.map((e) => [e, unknownAnswer(`reoon HTTP ${create.status}`)])),
        httpStatus: create.status,
        error: create.error ?? `HTTP ${create.status}`,
        chargedEmails: [],
      };
    }
    let taskId: number | string | undefined;
    try {
      taskId = (JSON.parse(create.body) as { task_id?: number | string }).task_id;
    } catch {
      taskId = undefined;
    }
    if (taskId == null) {
      return {
        answers: new Map(emails.map((e) => [e, unknownAnswer('reoon: no task id returned')])),
        httpStatus: create.status,
        error: 'no task id returned',
        chargedEmails: [],
      };
    }

    const resultUrl = `https://emailverifier.reoon.com/api/v1/get-result-bulk-verification-task/?key=${encodeURIComponent(apiKey)}&task_id=${encodeURIComponent(String(taskId))}`;
    // Bulk tasks are queued server-side; poll with a ceiling rather than forever.
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(attempt === 0 ? 3000 : 5000);
      const res = await httpRequest(resultUrl, { maxRetries: 1, timeoutMs: 30_000 });
      if (res.blocked) return blockedResult(res, emails);
      if (!res.ok) continue;
      let parsed: { status?: string; results?: Record<string, ReoonSingle> };
      try {
        parsed = JSON.parse(res.body) as typeof parsed;
      } catch {
        continue;
      }
      if ((parsed.status ?? '').toLowerCase() !== 'completed' || !parsed.results) continue;

      const answers = new Map<string, ProviderAnswer>();
      for (const [email, row] of Object.entries(parsed.results)) {
        answers.set(normalizeEmail(email), normalizeReoon(row));
      }
      for (const e of emails) if (!answers.has(e)) answers.set(e, unknownAnswer('reoon: absent from bulk result'));
      return { answers, httpStatus: res.status, chargedEmails: emails };
    }

    // The task was created, so the credits are gone whether or not we saw the
    // answer. Report it as charged so the ledger stays honest.
    return {
      answers: new Map(emails.map((e) => [e, unknownAnswer('reoon: bulk task did not complete in time')])),
      httpStatus: 200,
      error: 'bulk task timed out',
      chargedEmails: emails,
    };
  },
  async testKey(apiKey) {
    // Probing a bulk task id that cannot exist authenticates the key without
    // burning a credit.
    const res = await httpRequest(
      `https://emailverifier.reoon.com/api/v1/get-result-bulk-verification-task/?key=${encodeURIComponent(apiKey)}&task_id=0`,
      { maxRetries: 0, timeoutMs: 15_000 },
    );
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Reoon rejected the API key.' };
    if (res.status === 0) return { ok: false, message: res.error ?? 'Could not reach Reoon.' };
    const body = res.body.toLowerCase();
    if (body.includes('invalid') && body.includes('key')) return { ok: false, message: 'Reoon rejected the API key.' };
    return { ok: true, message: 'Reoon key accepted.' };
  },
};

// ── Bouncer ──────────────────────────────────────────────────────────────────

interface BouncerResult {
  email?: string;
  status?: string;
  reason?: string;
  domain?: { name?: string; acceptAll?: string };
  account?: { role?: boolean; disposable?: boolean; free?: boolean; fullMailbox?: string };
  toxic?: string;
}

function normalizeBouncer(r: BouncerResult): ProviderAnswer {
  const status = (r.status ?? '').toLowerCase();
  const acceptAll = (r.domain?.acceptAll ?? '').toLowerCase();
  const catchAll = acceptAll === 'yes' ? true : acceptAll === 'no' ? false : null;
  let verdict: VerificationVerdict;
  if (status === 'deliverable') verdict = 'valid';
  else if (status === 'undeliverable') verdict = 'invalid';
  else if (status === 'risky') verdict = catchAll === true ? 'catch_all' : 'unknown';
  else verdict = 'unknown';
  if (r.account?.disposable === true) verdict = 'disposable';
  if (verdict === 'valid' && catchAll === true) verdict = 'catch_all';
  return {
    verdict,
    catchAll,
    role: r.account?.role === true,
    disposable: r.account?.disposable === true,
    free: r.account?.free === true,
    reason: r.reason ? `bouncer: ${r.reason}` : `bouncer: ${status || 'no status'}`,
    raw: r,
  };
}

const bouncer: ProviderAdapter = {
  id: 'bouncer',
  batchSize: 500,
  async verify(apiKey, emails) {
    const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };

    if (emails.length === 1) {
      const res = await httpRequest(
        `https://api.usebouncer.com/v1/email/verify?email=${encodeURIComponent(emails[0]!)}&timeout=25`,
        { ...PAID_HTTP, headers },
      );
      if (res.blocked) return blockedResult(res, emails);
      if (!res.ok) {
        return {
          answers: new Map([[emails[0]!, unknownAnswer(`bouncer HTTP ${res.status}`)]]),
          httpStatus: res.status,
          error: res.error ?? `HTTP ${res.status}`,
          chargedEmails: [],
        };
      }
      try {
        const parsed = JSON.parse(res.body) as BouncerResult;
        const answer = normalizeBouncer(parsed);
        // Bouncer does not bill unknowns.
        return {
          answers: new Map([[emails[0]!, answer]]),
          httpStatus: res.status,
          chargedEmails: answer.verdict === 'unknown' ? [] : [emails[0]!],
        };
      } catch {
        return {
          answers: new Map([[emails[0]!, unknownAnswer('bouncer: unparseable response')]]),
          httpStatus: res.status,
          error: 'unparseable response',
          chargedEmails: [],
        };
      }
    }

    const create = await httpRequest('https://api.usebouncer.com/v1/email/verify/batch', {
      ...PAID_HTTP,
      method: 'POST',
      headers,
      body: JSON.stringify(emails.map((email) => ({ email }))),
    });
    if (create.blocked) return blockedResult(create, emails);
    if (!create.ok) {
      return {
        answers: new Map(emails.map((e) => [e, unknownAnswer(`bouncer HTTP ${create.status}`)])),
        httpStatus: create.status,
        error: create.error ?? `HTTP ${create.status}`,
        chargedEmails: [],
      };
    }
    let batchId: string | undefined;
    try {
      batchId = (JSON.parse(create.body) as { batchId?: string }).batchId;
    } catch {
      batchId = undefined;
    }
    if (!batchId) {
      return {
        answers: new Map(emails.map((e) => [e, unknownAnswer('bouncer: no batch id returned')])),
        httpStatus: create.status,
        error: 'no batch id returned',
        chargedEmails: [],
      };
    }

    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(attempt === 0 ? 3000 : 5000);
      const status = await httpRequest(`https://api.usebouncer.com/v1/email/verify/batch/${batchId}`, {
        maxRetries: 1,
        timeoutMs: 30_000,
        headers,
      });
      if (status.blocked) return blockedResult(status, emails);
      if (!status.ok) continue;
      let state = '';
      try {
        state = String((JSON.parse(status.body) as { status?: string }).status ?? '').toLowerCase();
      } catch {
        continue;
      }
      if (state !== 'completed') continue;

      const dl = await httpRequest(
        `https://api.usebouncer.com/v1/email/verify/batch/${batchId}/download?download=all`,
        { maxRetries: 1, timeoutMs: 60_000, headers },
      );
      if (dl.blocked) return blockedResult(dl, emails);
      if (!dl.ok) break;
      const answers = new Map<string, ProviderAnswer>();
      try {
        for (const r of JSON.parse(dl.body) as BouncerResult[]) {
          if (r.email) answers.set(normalizeEmail(r.email), normalizeBouncer(r));
        }
      } catch {
        break;
      }
      for (const e of emails) if (!answers.has(e)) answers.set(e, unknownAnswer('bouncer: absent from batch result'));
      const charged = emails.filter((e) => answers.get(e)?.verdict !== 'unknown');
      return { answers, httpStatus: dl.status, chargedEmails: charged };
    }

    return {
      answers: new Map(emails.map((e) => [e, unknownAnswer('bouncer: batch did not complete in time')])),
      httpStatus: 200,
      error: 'batch timed out',
      chargedEmails: emails,
    };
  },
  async testKey(apiKey) {
    const res = await httpRequest('https://api.usebouncer.com/v1/credits', {
      maxRetries: 0,
      timeoutMs: 15_000,
      headers: { 'x-api-key': apiKey },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Bouncer rejected the API key.' };
    if (!res.ok) return { ok: false, message: res.error ?? `Bouncer returned ${res.status}.` };
    try {
      const credits = (JSON.parse(res.body) as { credits?: number }).credits;
      return { ok: true, message: `Bouncer key accepted — ${credits ?? '?'} credits remaining.` };
    } catch {
      return { ok: true, message: 'Bouncer key accepted.' };
    }
  },
};

// ── MillionVerifier ──────────────────────────────────────────────────────────

interface MvResult {
  email?: string;
  result?: string;
  resultcode?: number;
  subresult?: string;
  role?: boolean;
  free?: boolean;
  error?: string;
  credits?: number;
}

function normalizeMv(r: MvResult): ProviderAnswer {
  const result = (r.result ?? '').toLowerCase();
  let verdict: VerificationVerdict;
  switch (result) {
    case 'ok':
      verdict = 'valid';
      break;
    case 'invalid':
      verdict = 'invalid';
      break;
    case 'catch_all':
      verdict = 'catch_all';
      break;
    case 'disposable':
      verdict = 'disposable';
      break;
    default:
      verdict = 'unknown';
  }
  return {
    verdict,
    catchAll: result === 'catch_all' ? true : result === 'ok' ? false : null,
    role: r.role === true,
    disposable: result === 'disposable',
    free: r.free === true,
    reason: `millionverifier: ${result}${r.subresult ? ` (${r.subresult})` : ''}`,
    raw: r,
  };
}

const millionverifier: ProviderAdapter = {
  id: 'millionverifier',
  // The bulk endpoint is a file-upload workflow, which buys nothing at this
  // volume; single lookups keep the ledger one-row-per-address.
  batchSize: 1,
  async verify(apiKey, emails) {
    const email = emails[0]!;
    const res = await httpRequest(
      `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=20`,
      PAID_HTTP,
    );
    if (res.blocked) return blockedResult(res, emails);
    if (!res.ok) {
      return {
        answers: new Map([[email, unknownAnswer(`millionverifier HTTP ${res.status}`)]]),
        httpStatus: res.status,
        error: res.error ?? `HTTP ${res.status}`,
        chargedEmails: [],
      };
    }
    let parsed: MvResult;
    try {
      parsed = JSON.parse(res.body) as MvResult;
    } catch {
      return {
        answers: new Map([[email, unknownAnswer('millionverifier: unparseable response')]]),
        httpStatus: res.status,
        error: 'unparseable response',
        chargedEmails: [],
      };
    }
    if (parsed.error) {
      return {
        answers: new Map([[email, unknownAnswer(`millionverifier: ${parsed.error}`)]]),
        httpStatus: res.status,
        error: parsed.error,
        chargedEmails: [],
      };
    }
    const answer = normalizeMv(parsed);
    // Catch-alls are refunded because the service declines to verify them.
    const charged = answer.verdict === 'catch_all' ? [] : [email];
    return { answers: new Map([[email, answer]]), httpStatus: res.status, chargedEmails: charged };
  },
  async testKey(apiKey) {
    const res = await httpRequest(
      `https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(apiKey)}`,
      { maxRetries: 0, timeoutMs: 15_000 },
    );
    if (!res.ok) return { ok: false, message: res.error ?? `MillionVerifier returned ${res.status}.` };
    try {
      const parsed = JSON.parse(res.body) as { credits?: number; error?: string };
      if (parsed.error) return { ok: false, message: `MillionVerifier: ${parsed.error}` };
      return { ok: true, message: `MillionVerifier key accepted — ${parsed.credits ?? '?'} credits remaining.` };
    } catch {
      return { ok: false, message: 'MillionVerifier returned an unreadable response.' };
    }
  },
};

const ADAPTERS: Record<Exclude<VerifierProvider, 'none'>, ProviderAdapter> = {
  reoon,
  bouncer,
  millionverifier,
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function testVerifierKey(db: Db): Promise<{ ok: boolean; message: string }> {
  const config = await loadVerifierConfig(db);
  if (config.provider === 'none') return { ok: false, message: 'No verification provider selected.' };
  if (!config.apiKey) return { ok: false, message: 'No API key set for the selected provider.' };
  return ADAPTERS[config.provider].testKey(config.apiKey);
}

/** What a run would cost, before the operator confirms it. */
export function estimateVerifyCostUsd(provider: VerifierProvider, count: number): number {
  return (COST_MICROS[provider] * count) / 1e6;
}

export async function verifyEmail(
  db: Db,
  rawEmail: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const [result] = await verifyEmails(db, [rawEmail], opts);
  return result!;
}

/**
 * Verifies a set of addresses, spending as little as possible:
 * free prefilter → cache → ledger reservation → one batched provider call.
 *
 * Results are deduplicated by normalised address, so the returned array is one
 * entry per distinct address rather than one per input.
 */
export async function verifyEmails(
  db: Db,
  rawEmails: string[],
  opts: VerifyOptions = {},
): Promise<VerifyResult[]> {
  const config = opts.config ?? (await loadVerifierConfig(db));
  const now = () => Date.now();
  const results = new Map<string, VerifyResult>();
  const order: string[] = [];

  const needsPaid: string[] = [];
  const prefilterByEmail = new Map<string, Awaited<ReturnType<typeof prefilter>>>();

  // DNS is the slow part of the free stage; run it with bounded concurrency
  // before the sequential ledger work.
  const prefilters = await mapLimit(rawEmails, 8, (raw) => prefilter(db, raw));

  const seen = new Set<string>();
  for (let idx = 0; idx < rawEmails.length; idx++) {
    const raw = rawEmails[idx]!;
    const pre = prefilters[idx] ?? (await prefilter(db, raw));
    const email = pre.email || normalizeEmail(raw);
    if (seen.has(email)) continue;
    seen.add(email);
    order.push(email);
    prefilterByEmail.set(email, pre);

    if (pre.verdict && !(pre.verdict === 'role' && opts.observed && config.provider !== 'none')) {
      results.set(email, {
        email,
        verdict: pre.verdict,
        catchAll: null,
        role: pre.role,
        disposable: pre.disposable,
        free: false,
        provider: 'local',
        mxProvider: pre.provider,
        reason: pre.reason,
        evidenceId: null,
        costMicros: 0,
        verifiedAt: now(),
        cached: true,
      });
      continue;
    }

    if (!pre.verdict && !pre.worthVerifying) {
      // DNS was unreachable. Leave it unverified so a later run retries.
      results.set(email, {
        email,
        verdict: 'unverified',
        catchAll: null,
        role: pre.role,
        disposable: false,
        free: false,
        provider: 'local',
        mxProvider: pre.provider,
        reason: pre.reason,
        evidenceId: null,
        costMicros: 0,
        verifiedAt: now(),
        cached: true,
      });
      continue;
    }

    if (config.provider === 'none' || !config.apiKey) {
      results.set(email, {
        email,
        verdict: 'unverified',
        catchAll: null,
        role: pre.role,
        disposable: false,
        free: false,
        provider: 'local',
        mxProvider: pre.provider,
        reason: config.provider === 'none' ? 'No verification provider configured' : 'No API key configured',
        evidenceId: null,
        costMicros: 0,
        verifiedAt: now(),
        cached: true,
      });
      continue;
    }

    const cacheKey = canonicalizeForCache(email);
    if (!opts.force) {
      const hit = cachedEvidence(db, config.provider, cacheKey, config.freshnessDays * 86_400_000);
      if (hit) {
        results.set(email, {
          email,
          verdict: hit.env.normalized.verdict,
          catchAll: hit.env.normalized.catchAll,
          role: hit.env.normalized.role || pre.role,
          disposable: hit.env.normalized.disposable,
          free: hit.env.normalized.free,
          provider: config.provider,
          mxProvider: pre.provider,
          reason: `${hit.env.normalized.reason} (cached)`,
          evidenceId: hit.id,
          costMicros: 0,
          verifiedAt: hit.fetchedAt,
          cached: true,
        });
        continue;
      }
    }

    needsPaid.push(email);
  }

  if (needsPaid.length === 0) return order.map((e) => results.get(e)!);

  const adapter = ADAPTERS[config.provider as Exclude<VerifierProvider, 'none'>];
  const unitCost = COST_MICROS[config.provider];

  assertSpendAvailable(db, config.provider, unitCost * needsPaid.length, config.spendCapMicros);

  // Reserve every address before a single byte goes out.
  const reservations = new Map<string, Reservation>();
  const toCall: string[] = [];
  for (const email of needsPaid) {
    const key = idempotencyKeyFor(
      db,
      config.provider,
      canonicalizeForCache(email),
      opts.force === true,
      config.freshnessDays * 86_400_000,
    );
    const reservation = reserveApiCall(db, {
      provider: config.provider,
      endpoint: adapter.batchSize > 1 && needsPaid.length > 1 ? 'verify/batch' : 'verify',
      key,
      entityType: opts.entityType,
      entityId: opts.entityId,
      estCostMicros: unitCost,
    });
    reservations.set(email, reservation);

    if (reservation.id == null) {
      const pre = prefilterByEmail.get(email)!;
      const blocker = reservation.blockedBy;
      const stale = blocker ? Date.now() - blocker.started_at > 15 * 60_000 : false;
      results.set(email, {
        email,
        verdict: 'unknown',
        catchAll: null,
        role: pre.role,
        disposable: false,
        free: false,
        provider: config.provider,
        mxProvider: pre.provider,
        reason:
          blocker?.state === 'reserved' && stale
            ? 'A previous verification of this address did not finish. Use Re-verify to spend another credit.'
            : 'Already charged for this address — not spending a second credit.',
        evidenceId: null,
        costMicros: 0,
        verifiedAt: now(),
        cached: true,
      });
      continue;
    }
    toCall.push(email);
  }

  let blocked = false;

  for (let i = 0; i < toCall.length && !blocked; i += adapter.batchSize) {
    const chunk = toCall.slice(i, i + adapter.batchSize);
    let call: ProviderCallResult;
    try {
      call = await adapter.verify(config.apiKey, chunk);
    } catch (err) {
      call = {
        answers: new Map(chunk.map((e) => [e, unknownAnswer(String(err))])),
        httpStatus: 0,
        error: err instanceof Error ? err.message : String(err),
        chargedEmails: [],
      };
    }

    if (call.blocked) blocked = true;
    const chargedSet = new Set(call.chargedEmails.map((e) => canonicalizeForCache(normalizeEmail(e))));

    for (const email of chunk) {
      const pre = prefilterByEmail.get(email)!;
      const reservation = reservations.get(email)!;
      const answer = call.answers.get(email) ?? call.answers.get(canonicalizeForCache(email)) ?? unknownAnswer('No answer returned');
      const charged = chargedSet.has(canonicalizeForCache(email));
      const costMicros = charged ? unitCost : 0;

      // An observed role account that the provider confirms exists is reported
      // as valid; the decision table still routes it to review rather than an
      // automatic send.
      let verdict = answer.verdict;
      if (pre.role && verdict !== 'valid' && verdict !== 'invalid' && verdict !== 'disposable') verdict = 'role';

      const envelope: EvidenceEnvelope = {
        provider: config.provider,
        email: canonicalizeForCache(email),
        httpStatus: call.httpStatus,
        requestedAt: now(),
        normalized: {
          verdict,
          catchAll: answer.catchAll,
          role: answer.role || pre.role,
          disposable: answer.disposable,
          free: answer.free,
          reason: answer.reason,
        },
        raw: answer.raw,
      };

      let evidenceId: number | null = null;
      // A blocked or errored call produced no judgement worth storing as evidence.
      if (!call.blocked && answer.raw != null) evidenceId = storeEvidence(db, envelope, costMicros);

      commitApiCall(db, reservation.id!, {
        state: call.error || call.blocked ? 'failed' : 'succeeded',
        httpStatus: call.httpStatus,
        costMicros,
        error: call.error,
      });
      recordSpend(db, config.provider, costMicros);

      if (answer.catchAll != null) saveCatchAllFlag(db, domainOf(email), answer.catchAll);

      results.set(email, {
        email,
        verdict,
        catchAll: answer.catchAll,
        role: answer.role || pre.role,
        disposable: answer.disposable,
        free: answer.free,
        provider: config.provider,
        mxProvider: pre.provider,
        reason: call.blocked ? `${config.provider} returned ${call.httpStatus} — stopped` : answer.reason,
        evidenceId,
        costMicros,
        verifiedAt: now(),
        cached: false,
        blocked: call.blocked,
      });
    }
  }

  // Anything after a block never got called; its reservation is released so a
  // later run can retry without an extra ledger key.
  for (const email of toCall) {
    if (results.has(email)) continue;
    const reservation = reservations.get(email)!;
    commitApiCall(db, reservation.id!, {
      state: 'failed',
      httpStatus: null,
      costMicros: 0,
      error: 'not attempted — provider blocked earlier in the run',
    });
    const pre = prefilterByEmail.get(email)!;
    results.set(email, {
      email,
      verdict: 'unverified',
      catchAll: null,
      role: pre.role,
      disposable: false,
      free: false,
      provider: config.provider,
      mxProvider: pre.provider,
      reason: 'Not attempted — verification stopped',
      evidenceId: null,
      costMicros: 0,
      verifiedAt: now(),
      cached: true,
      blocked: true,
    });
  }

  if (blocked) {
    // Surface it loudly; the pipeline is expected to stop this source.
    console.warn(`[verify] ${config.provider} blocked the run. Stopping verification.`);
  }

  return order.map((e) => results.get(e)!);
}
