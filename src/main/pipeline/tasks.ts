/**
 * Durable task queue + the paid-API cost ledger.
 *
 * Both live here because both are infrastructure that everything else builds on
 * and neither may import anything above it in the dependency graph.
 *
 * The claim is a single `UPDATE ... WHERE id = (SELECT ...) RETURNING *`. SQLite
 * executes that atomically, so the main process and the pipeline
 * can both poll the same table without a lock, a lease column, or a race.
 */

import { getDb, all, get, run, type Db } from '../db/index.js';

export interface TaskRow {
  id: number;
  kind: string;
  dedupe_key: string | null;
  payload: string;
  priority: number;
  state: 'pending' | 'running' | 'done' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  run_after: number;
  last_error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface EnqueueOptions {
  /** Unique among pending/running tasks of the same kind. Null disables dedupe. */
  dedupeKey?: string | null;
  /** Lower runs first. */
  priority?: number;
  maxAttempts?: number;
  /** Epoch ms; the task is invisible to claim() until then. */
  runAfter?: number;
}

/**
 * Returns the new task id, or null when an identical task is already queued.
 *
 * The ON CONFLICT target repeats the partial index's predicate verbatim —
 * without it SQLite cannot match the partial unique index and the insert throws
 * instead of deduping.
 */
export function enqueue(
  db: Db,
  kind: string,
  payload: unknown = {},
  opts: EnqueueOptions = {},
): number | null {
  const row = get<{ id: number }>(
    db,
    `INSERT INTO task (kind, dedupe_key, payload, priority, max_attempts, run_after)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, dedupe_key)
       WHERE dedupe_key IS NOT NULL AND state IN ('pending','running')
       DO NOTHING
     RETURNING id`,
    kind,
    opts.dedupeKey ?? null,
    JSON.stringify(payload ?? {}),
    opts.priority ?? 100,
    opts.maxAttempts ?? 5,
    opts.runAfter ?? 0,
  );
  return row?.id ?? null;
}

/** Atomically take the highest-priority runnable task, or null if none is due. */
export function claim(db: Db, now = Date.now()): TaskRow | null {
  const row = get<TaskRow>(
    db,
    `UPDATE task
        SET state = 'running', attempts = attempts + 1, started_at = ?, finished_at = NULL
      WHERE id = (
        SELECT id FROM task
         WHERE state = 'pending' AND run_after <= ?
         ORDER BY priority, id
         LIMIT 1
      )
      RETURNING *`,
    now,
    now,
  );
  return row ?? null;
}

export function complete(db: Db, id: number): void {
  run(db, `UPDATE task SET state = 'done', last_error = NULL, finished_at = ? WHERE id = ?`, Date.now(), id);
}

/**
 * Exponential backoff with full jitter, capped at an hour. A task that has burned
 * all its attempts goes to 'dead' rather than retrying forever — the operator
 * sees it in the log and decides.
 */
export function fail(db: Db, id: number, error: unknown): 'retry' | 'dead' {
  const task = get<{ attempts: number; max_attempts: number }>(
    db,
    'SELECT attempts, max_attempts FROM task WHERE id = ?',
    id,
  );
  if (!task) return 'dead';

  const message = truncate(error instanceof Error ? error.message : String(error), 2000);
  const exhausted = task.attempts >= task.max_attempts;

  if (exhausted) {
    run(db, `UPDATE task SET state = 'dead', last_error = ?, finished_at = ? WHERE id = ?`, message, Date.now(), id);
    return 'dead';
  }

  run(
    db,
    `UPDATE task SET state = 'pending', last_error = ?, run_after = ?, finished_at = NULL WHERE id = ?`,
    message,
    Date.now() + backoffMs(task.attempts),
    id,
  );
  return 'retry';
}

/**
 * Dead-letter a task unconditionally, bypassing the retry ladder. For defects
 * (unknown kind, unparseable payload) where retrying can only repeat the
 * failure and delay the burial `fail()` would eventually reach.
 */
export function bury(db: Db, id: number, error: unknown): void {
  const message = truncate(error instanceof Error ? error.message : String(error), 2000);
  run(db, `UPDATE task SET state = 'dead', last_error = ?, finished_at = ? WHERE id = ?`, message, Date.now(), id);
}

export function backoffMs(attempts: number): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

/**
 * A crash leaves tasks stuck in 'running'. At startup the single-instance lock
 * guarantees no other process can be mid-task, so callers pass staleMs = 0 and
 * every 'running' row is requeued regardless of age — the old 30-minute floor
 * left a crash-then-quick-relaunch task wedged (and its dedupe key blocked
 * re-enqueueing the same work) until some later restart. The floor exists for
 * any future PERIODIC caller, where an in-flight task really could be running.
 */
export function requeueStale(db: Db, staleMs = 30 * 60_000): number {
  const cutoff = Date.now() - staleMs;
  const rows = all<{ id: number }>(
    db,
    `UPDATE task SET state = 'pending', run_after = 0
      WHERE state = 'running' AND COALESCE(started_at, 0) < ?
      RETURNING id`,
    cutoff,
  );
  return rows.length;
}

export function taskCounts(db: Db): Record<TaskRow['state'], number> {
  const rows = all<{ state: TaskRow['state']; n: number }>(
    db,
    'SELECT state, count(*) AS n FROM task GROUP BY state',
  );
  const out: Record<TaskRow['state'], number> = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
  for (const r of rows) out[r.state] = r.n;
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// Cost ledger — reserve then commit
//
// The reservation row is written BEFORE the HTTP request, keyed by
// UNIQUE(provider, idempotency_key). A retry loop that re-enters the same call
// gets `null` from reserve() and physically cannot issue a second billable
// request. This is the guard against the classic "runaway enrichment loop spent
// $3k overnight" failure, and it lives in the database rather than in code
// because code is what fails.
// ─────────────────────────────────────────────────────────────────────────────

export interface Reservation {
  id: number;
  provider: string;
  idempotencyKey: string;
  estCostMicros: number;
}

export class SpendCapExceeded extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`Spend cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}`);
    this.name = 'SpendCapExceeded';
  }
}

/**
 * Returns null when this exact call has already been reserved (i.e. we have
 * already paid, or are paying, for this entity). Throws SpendCapExceeded when
 * the reservation would push total spend past the operator's cap.
 */
export function reserveApiCall(
  db: Db,
  args: {
    provider: string;
    endpoint: string;
    idempotencyKey: string;
    entityType?: string | null;
    entityId?: string | null;
    estCostMicros: number;
    capUsdMicros?: number;
  },
): Reservation | null {
  const cap = args.capUsdMicros;
  if (cap != null && cap >= 0) {
    const spent = totalSpentMicros(db);
    if (spent + args.estCostMicros > cap) {
      throw new SpendCapExceeded(spent / 1_000_000, cap / 1_000_000);
    }
  }

  const row = get<{ id: number }>(
    db,
    `INSERT INTO api_call (provider, endpoint, idempotency_key, entity_type, entity_id, state, est_cost_micros)
     VALUES (?, ?, ?, ?, ?, 'reserved', ?)
     ON CONFLICT (provider, idempotency_key) DO NOTHING
     RETURNING id`,
    args.provider,
    args.endpoint,
    args.idempotencyKey,
    args.entityType ?? null,
    args.entityId ?? null,
    Math.max(0, Math.round(args.estCostMicros)),
  );
  if (!row) return null;

  return {
    id: row.id,
    provider: args.provider,
    idempotencyKey: args.idempotencyKey,
    estCostMicros: args.estCostMicros,
  };
}

export function commitApiCall(
  db: Db,
  reservation: Reservation,
  result: { ok: boolean; httpStatus?: number | null; actualCostMicros?: number; error?: string | null },
): void {
  const actual = Math.max(0, Math.round(result.actualCostMicros ?? (result.ok ? reservation.estCostMicros : 0)));
  run(
    db,
    `UPDATE api_call
        SET state = ?, http_status = ?, actual_cost_micros = ?, error = ?, finished_at = ?
      WHERE id = ?`,
    result.ok ? 'succeeded' : 'failed',
    result.httpStatus ?? null,
    actual,
    result.error ? truncate(result.error, 1000) : null,
    Date.now(),
    reservation.id,
  );

  run(
    db,
    `INSERT INTO spend_cap (provider, cap_usd_micros, spent_usd_micros) VALUES (?, 0, ?)
     ON CONFLICT(provider) DO UPDATE SET spent_usd_micros = spent_usd_micros + excluded.spent_usd_micros`,
    reservation.provider,
    actual,
  );
}

/** Release a reservation that never became a request, so the key can be reused. */
export function releaseApiCall(db: Db, reservation: Reservation, reason: string): void {
  run(
    db,
    `DELETE FROM api_call WHERE id = ? AND state = 'reserved'`,
    reservation.id,
  );
  void reason;
}

/**
 * A crash between reserve and commit leaves rows 'reserved' forever: their
 * est_cost_micros counts against the spend cap indefinitely, and ledger
 * dedupe answers "already reserved" for work that never happened (the LLM
 * body rewrite then silently falls back to the template forever). At startup
 * the single-instance lock means every reserved row is an orphan. Marked
 * 'failed' rather than deleted: failed rows keep the audit trail and are the
 * state the verifier's no-credit-consumed reuse path already understands.
 */
export function releaseStaleReservations(db: Db): number {
  const rows = all<{ id: number }>(
    db,
    `UPDATE api_call
        SET state = 'failed', finished_at = ?,
            error = COALESCE(error, 'Reservation orphaned by an interrupted run; released at startup.')
      WHERE state = 'reserved'
      RETURNING id`,
    Date.now(),
  );
  return rows.length;
}

export function totalSpentMicros(db: Db): number {
  const row = get<{ n: number }>(
    db,
    `SELECT COALESCE(SUM(COALESCE(actual_cost_micros, est_cost_micros)), 0) AS n
       FROM api_call WHERE state IN ('reserved','succeeded')`,
  );
  return row?.n ?? 0;
}

export function spendByProvider(db: Db): { provider: string; spentUsd: number; capUsd: number }[] {
  const spent = all<{ provider: string; n: number }>(
    db,
    `SELECT provider, COALESCE(SUM(COALESCE(actual_cost_micros, est_cost_micros)), 0) AS n
       FROM api_call WHERE state IN ('reserved','succeeded') GROUP BY provider`,
  );
  const caps = new Map(
    all<{ provider: string; cap_usd_micros: number }>(db, 'SELECT provider, cap_usd_micros FROM spend_cap').map(
      (r) => [r.provider, r.cap_usd_micros],
    ),
  );
  return spent.map((s) => ({
    provider: s.provider,
    spentUsd: s.n / 1_000_000,
    capUsd: (caps.get(s.provider) ?? caps.get('all') ?? 0) / 1_000_000,
  }));
}


function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
