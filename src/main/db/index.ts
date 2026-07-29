/**
 * Database layer — node:sqlite only, zero native dependencies.
 *
 * That choice is why packaging is painless: Electron 43 bundles Node 24, which
 * ships SQLite 3.51+ with WAL, FTS5, STRICT tables, JSONB and RETURNING all
 * compiled in. No better-sqlite3, no @electron/rebuild, no ABI matching, no
 * per-platform prebuilds. Verified on this machine before it was chosen.
 *
 * Note: Bun has no `node:sqlite`, so the backend always runs under Node. Bun is
 * the package manager and task runner only.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import schemaSql from './schema.sql';
import { normName, canonicalCompanyValue } from '../pipeline/canon.js';

export type Db = DatabaseSync;

let _db: Db | null = null;

export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  warnIfSyncedFolder(file);

  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });

  // busy_timeout FIRST. Switching journal modes needs a brief exclusive lock, so
  // a second connection opening while the first is mid-write fails outright
  // without a busy handler already installed.
  db.exec('PRAGMA busy_timeout = 5000');
  // Readers never block the writer and vice versa. Required because the UI reads
  // while the pipeline worker writes.
  enableWal(db, file);
  // NORMAL is the right durability trade for a local research tool: safe against
  // process crash, at risk only from OS/power loss, which a re-run fixes.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA cache_size = -65536'); // 64 MB
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  // journal_mode is a request, not a guarantee: on a filesystem without the
  // shared-memory primitives WAL needs (most network mounts) SQLite silently
  // stays in rollback-journal mode, where a writer blocks every reader and the
  // UI freezes for the length of a crawl. Say so rather than let the operator
  // discover it as "the app hangs".
  const mode = get<{ journal_mode: string }>(db, 'PRAGMA journal_mode')?.journal_mode ?? '?';
  if (mode.toLowerCase() !== 'wal') {
    console.warn(
      `[db] WARNING: journal_mode is '${mode}', not WAL (${file}).\n` +
        `     Reads and writes will block each other. This usually means the database\n` +
        `     is on a network or synced volume; move it with RECRUITAI_DATA.`,
    );
  }

  const fromVersion = migrate(db);
  // A kill-9 inside bulkLoadReqs leaves the FTS triggers dropped forever —
  // migrations are already applied, so nothing else would ever recreate them
  // and search would silently miss every req written since the crash.
  ensureFtsTriggers(db);
  // name_norm predates the Unicode-aware normName (migration v3 era): recompute
  // rows the old ASCII-only normaliser mangled, and re-canonicalise company
  // suppression values in the same pass so both sides of the match move
  // together. Fresh databases (fromVersion 0) have nothing to backfill.
  if (fromVersion > 0 && fromVersion < 3) backfillUnicodeNorms(db);
  return db;
}

export function getDb(): Db {
  if (!_db) throw new Error('Database not opened. Call initDb() first.');
  return _db;
}

export function initDb(file: string): Db {
  _db = openDb(file);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.exec('PRAGMA optimize');
    } catch {
      /* best effort */
    }
    _db.close();
    _db = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrations — PRAGMA user_version as the version counter.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: schemaSql },
  {
    // Follow-ups. The old draft_contact index counted sent/failed rows, so a
    // second draft for a contact was impossible forever; the constraint's real
    // intent is one ACTIVE draft per contact. follow_up_of links a bump draft
    // to the send it threads onto (gmail thread id + Message-ID live there).
    version: 2,
    sql: `
      DROP INDEX draft_contact;
      CREATE UNIQUE INDEX draft_contact ON draft(contact_id) WHERE state IN ('draft','queued','sending');
      ALTER TABLE draft ADD COLUMN follow_up_of TEXT REFERENCES send(id);
      CREATE INDEX draft_follow_up ON draft(follow_up_of) WHERE follow_up_of IS NOT NULL;
      -- Consecutive refresh 404s. One is an outage; three in a row is a dead
      -- board, whose reqs then close via the normal differ.
      ALTER TABLE company ADD COLUMN ats_miss_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Measured at the 10k-company envelope: the sendable predicate and the
    // inbox reply-matcher were scanning where they should seek. These four
    // indexes plus the canonical-lowercase suppression invariant (enforced
    // going forward by addSuppressionRow; normalised here for legacy rows)
    // take the hot send/inbox paths from ~56ms and ~8s to sub-millisecond.
    version: 3,
    sql: `
      CREATE INDEX send_contact ON send(contact_id);
      CREATE INDEX inbound_unhandled ON inbound(send_id) WHERE handled = 0;
      CREATE INDEX send_to_email ON send(lower(to_email), sent_at DESC);
      CREATE INDEX field_observation_evidence ON field_observation(evidence_id) WHERE evidence_id IS NOT NULL;
      CREATE INDEX api_call_spend ON api_call(actual_cost_micros, est_cost_micros) WHERE state IN ('reserved','succeeded');
      UPDATE suppression SET value = lower(value);
      ANALYZE;
    `,
  },
  {
    // The verifier's "have we already paid for this address?" cache looked up
    // raw_response by (source, url) with only (source, fetched_at) to ride, so
    // every lookup walked the whole verifier partition — and a MISS, which is
    // the common case for a new address, walked all of it. Measured at 20k
    // stored verdicts: 3.3ms per address before, 0.003ms after, and the old
    // cost grows linearly with every address ever verified.
    version: 4,
    sql: `
      CREATE INDEX raw_source_url ON raw_response(source, url, fetched_at DESC);
      ANALYZE raw_response;
    `,
  },
  {
    // Pattern inference asked "which observed addresses are at this domain?"
    // with lower(email) LIKE '%@domain' — a leading wildcard, so it scanned
    // every contact AND every field_observation, once per company verified.
    // Measured 21ms per company at 20k contacts + 20k observations, growing
    // with the whole database: a full verification pass spent minutes here.
    // The expression must stay byte-identical to EMAIL_DOMAIN_EXPR in
    // verify/pattern.ts or SQLite silently declines to use these.
    version: 5,
    sql: `
      CREATE INDEX contact_email_domain
        ON contact(substr(lower(email), instr(lower(email), '@') + 1))
        WHERE email IS NOT NULL;
      CREATE INDEX fo_email_domain
        ON field_observation(substr(lower(value), instr(lower(value), '@') + 1))
        WHERE entity = 'contact' AND field = 'email' AND value IS NOT NULL;
      ANALYZE contact;
      ANALYZE field_observation;
    `,
  },
  {
    // Suppression lookups became bare index seeks (`s.value = lower(?)`), which
    // turns lowercase from a convention into a correctness invariant: a row
    // stored with any uppercase silently suppresses NOTHING. That fails open —
    // the operator emails an existing client while the table says they should
    // not have. addSuppressionRow canonicalises, but a CSV import or any future
    // writer bypasses it, so enforce it in the schema rather than trusting every
    // call site. SQLite cannot add a CHECK to an existing table, so rebuild.
    version: 6,
    sql: `
      CREATE TABLE suppression_v6 (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('domain','email','company')),
        value      TEXT NOT NULL CHECK (value = lower(value)),
        reason     TEXT NOT NULL
                     CHECK (reason IN ('existing_client','active_contract','past_rejection',
                                       'placed_candidate_employer','competitor','no_agency_policy',
                                       'replied_no','bounced','manual','opt_out')),
        note       TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
        UNIQUE (kind, value)
      ) STRICT;

      -- lower() again rather than trusting the v3 backfill: a row inserted since
      -- then by a path that skipped canonicalisation would otherwise abort this.
      -- OR IGNORE because two rows differing only in case collapse to one here.
      INSERT OR IGNORE INTO suppression_v6 (id, kind, value, reason, note, created_at)
        SELECT id, kind, lower(value), reason, note, created_at FROM suppression;

      DROP TABLE suppression;
      ALTER TABLE suppression_v6 RENAME TO suppression;
    `,
  },
];

/** The newest schema this build knows how to produce and read. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function userVersion(db: Db): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0;
}

/** Returns the version the database was at BEFORE any migrations ran. */
function migrate(db: Db): number {
  const startedAt = userVersion(db);

  // Downgrades are the dangerous direction and the silent one: an older build
  // sees a newer file, has no migration left to run, and happily writes rows
  // that ignore columns and constraints it does not know about. Refuse instead.
  if (startedAt > SCHEMA_VERSION) {
    throw new Error(
      `Database is schema v${startedAt} but this build of recruitAI only understands v${SCHEMA_VERSION}. ` +
        `It was written by a newer version. Refusing to open it — continuing would write rows that ` +
        `ignore the newer schema. Update the app, or point RECRUITAI_DATA at a different folder.`,
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= startedAt) continue;
    // BEGIN IMMEDIATE, not BEGIN: a deferred transaction only takes the write
    // lock at its first write, which leaves the read of user_version outside
    // any lock. Two processes starting together (the app and `bun run seed`,
    // say) would then both decide to apply the same migration, and the loser
    // dies on "table already exists" — with node:sqlite exec() running the
    // whole script, a partial apply. Re-reading the version under the write
    // lock makes check-and-set atomic; the second process just skips.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (userVersion(db) >= m.version) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A statement error can unwind the transaction itself; letting the
        // rollback throw here would replace the real migration failure with
        // "no transaction is active".
      }
      throw new Error(`Migration ${m.version} failed: ${err}`);
    }
  }
  return startedAt;
}

/**
 * Recreate the req FTS triggers if any are missing and resync the index.
 * Idempotent and cheap when all three exist (the normal case).
 */
export function ensureFtsTriggers(db: Db): void {
  const present =
    get<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('req_ai','req_au','req_ad')`,
    )?.n ?? 0;
  if (present === 3) return;

  const triggers = schemaSql.match(/CREATE TRIGGER req_a[iud][\s\S]*?END;/g) ?? [];
  tx(db, () => {
    for (const t of triggers) db.exec(t.replace('CREATE TRIGGER', 'CREATE TRIGGER IF NOT EXISTS'));
    // Rows written while the triggers were missing never reached req_fts.
    db.exec("INSERT INTO req_fts(req_fts) VALUES('rebuild')");
  });
}

/**
 * One-time repair after normName became Unicode-aware: recompute name_norm
 * where the old ASCII-only algorithm disagrees, and re-shape stored company
 * suppression values with the same rules (their old fallback form — the raw
 * lowercased name — matched no arm of COMPANY_SUPPRESSION_MATCH, i.e. the
 * suppression silently did not suppress).
 */
export function backfillUnicodeNorms(db: Db): void {
  tx(db, () => {
    const companies = all<{ id: string; name: string; name_norm: string }>(
      db,
      'SELECT id, name, name_norm FROM company',
    );
    for (const c of companies) {
      const norm = normName(c.name);
      if (norm !== c.name_norm) run(db, 'UPDATE company SET name_norm = ? WHERE id = ?', norm, c.id);
    }
    const sups = all<{ id: number; value: string }>(db, `SELECT id, value FROM suppression WHERE kind = 'company'`);
    for (const s of sups) {
      const canon = canonicalCompanyValue(s.value);
      if (canon === s.value) continue;
      try {
        run(db, 'UPDATE suppression SET value = ? WHERE id = ?', canon, s.id);
      } catch {
        // UNIQUE(kind, value): the canonical row already exists — this one is
        // a now-redundant duplicate.
        run(db, 'DELETE FROM suppression WHERE id = ?', s.id);
      }
    }
  });
}

/**
 * Switching a database into WAL takes a brief exclusive lock, and — unlike an
 * ordinary write — that switch does not run the busy handler, so busy_timeout
 * does not cover it. Two processes opening a database that is not yet in WAL at
 * the same moment (first launch, or the app and `bun run seed` starting
 * together) leaves one of them throwing "database is locked" out of openDb
 * before it has done anything at all. Measured 6-of-6 failures on a cold file.
 * So do the waiting here instead.
 */
function enableWal(db: Db, file: string): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw new Error(`Could not switch ${file} to WAL mode: ${err}`);
      sleepSync(20);
    }
  }
}

/** node:sqlite is synchronous, so the retry backoff has to be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const SYNCED_FOLDER_MARKERS = [
  // macOS 12.3+ mounts EVERY provider here — Google Drive, OneDrive, Dropbox,
  // Box — so its absence meant the warning did not fire for any of them on a
  // current Mac, which is the machine this app is built for.
  '/library/cloudstorage/',
  '/library/mobile documents/', // iCloud Drive
  '/dropbox/',
  '/google drive/',
  '/googledrive/', // /Volumes/GoogleDrive, the pre-12.3 mount
  '/onedrive', // "OneDrive - Contoso", "OneDrive-Personal": no trailing slash
  '/icloud',
  '/box sync/',
  '/pcloud',
  '/sync.com/',
  '/megasync/',
  '/nextcloud/',
  '/owncloud/',
  '/seafile/',
  '/creative cloud files',
];

/**
 * SQLite's WAL mode relies on shared-memory locking that cloud-sync folders
 * break, and the failure is silent corruption rather than an error. Warn loudly.
 */
export function isSyncedFolder(file: string): boolean {
  // Backslashes first: on Windows every one of these paths uses them, so a
  // forward-slash-only check never matched and the warning was dead code on
  // that platform. Lowercase because macOS and Windows paths are both
  // case-insensitive and the operator's folder may be spelled any way.
  const norm = file.replace(/\\/g, '/').toLowerCase();
  return SYNCED_FOLDER_MARKERS.some((m) => norm.includes(m));
}

function warnIfSyncedFolder(file: string): void {
  if (isSyncedFolder(file)) {
    console.warn(
      `[db] WARNING: database is inside a cloud-synced folder (${file}).\n` +
        `     SQLite WAL mode can corrupt silently there. Move it with RECRUITAI_DATA.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(
  db: Db,
  sql: string,
  ...params: unknown[]
): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return db.prepare(sql).run(...(params as never[]));
}

/** Prepared-statement cache — node:sqlite has no built-in one. */
const stmtCache = new WeakMap<Db, Map<string, StatementSync>>();

export function prep(db: Db, sql: string): StatementSync {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

// ─────────────────────────────────────────────────────────────────────────────
// ULID — time-sortable text ids, no dependency.
// ─────────────────────────────────────────────────────────────────────────────

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlidTime = 0;
let lastUlidRandom: number[] = [];

export function ulid(seedTime = Date.now()): string {
  let time = seedTime;
  let chars = '';
  for (let i = 9; i >= 0; i--) {
    chars = ULID_ALPHABET[time % 32]! + chars;
    time = Math.floor(time / 32);
  }

  // Monotonic within the same millisecond so bulk inserts stay ordered.
  if (seedTime === lastUlidTime) {
    for (let i = lastUlidRandom.length - 1; i >= 0; i--) {
      if (lastUlidRandom[i]! < 31) {
        lastUlidRandom[i]!++;
        break;
      }
      lastUlidRandom[i] = 0;
    }
  } else {
    lastUlidTime = seedTime;
    lastUlidRandom = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }

  return chars + lastUlidRandom.map((n) => ULID_ALPHABET[n]).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance
// ─────────────────────────────────────────────────────────────────────────────

export function backup(db: Db, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

export function dbStats(db: Db): { sizeBytes: number; tables: Record<string, number> } {
  const pageCount = (get<{ page_count: number }>(db, 'PRAGMA page_count')?.page_count ?? 0);
  const pageSize = (get<{ page_size: number }>(db, 'PRAGMA page_size')?.page_size ?? 0);
  const names = all<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`,
  );
  const tables: Record<string, number> = {};
  for (const { name } of names) {
    tables[name] = get<{ c: number }>(db, `SELECT count(*) c FROM "${name}"`)?.c ?? 0;
  }
  // page_count covers the main file only. Between checkpoints the -wal holds
  // committed data too and routinely reaches tens of MB, so reporting page
  // count alone understates what the operator is actually using on disk.
  return { sizeBytes: pageCount * pageSize + walBytes(db), tables };
}

function walBytes(db: Db): number {
  const file = get<{ file: string | null }>(db, `SELECT file FROM pragma_database_list WHERE name = 'main'`)?.file;
  if (!file) return 0; // in-memory or temp database
  try {
    return fs.statSync(`${file}-wal`).size;
  } catch {
    return 0; // checkpointed away, or not in WAL mode
  }
}

/**
 * Bulk-load helper. FTS triggers cost ~6.4x on large inserts, so drop and
 * rebuild for anything over a couple of thousand rows.
 */
export function bulkLoadReqs<T>(db: Db, fn: () => T): T {
  db.exec('DROP TRIGGER IF EXISTS req_ai; DROP TRIGGER IF EXISTS req_au; DROP TRIGGER IF EXISTS req_ad;');
  try {
    return fn();
  } finally {
    const triggers = schemaSql.match(/CREATE TRIGGER req_a[iud][\s\S]*?END;/g) ?? [];
    for (const t of triggers) db.exec(t);
    db.exec("INSERT INTO req_fts(req_fts) VALUES('rebuild')");
  }
}
