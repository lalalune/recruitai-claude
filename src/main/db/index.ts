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

export type Db = DatabaseSync;

let _db: Db | null = null;

export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  warnIfSyncedFolder(file);

  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });

  // Readers never block the writer and vice versa. Required because the UI reads
  // while the pipeline worker writes.
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL is the right durability trade for a local research tool: safe against
  // process crash, at risk only from OS/power loss, which a re-run fixes.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA cache_size = -65536'); // 64 MB
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA wal_autocheckpoint = 1000');

  migrate(db);
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
];

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row?.user_version ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // node:sqlite exec() runs multiple statements; wrap so a bad migration
    // leaves the database untouched rather than half-applied.
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} failed: ${err}`);
    }
  }
}

/**
 * SQLite's WAL mode relies on shared-memory locking that cloud-sync folders
 * break, and the failure is silent corruption rather than an error. Warn loudly.
 */
function warnIfSyncedFolder(file: string): void {
  const risky = ['/Library/Mobile Documents/', '/Dropbox/', '/Google Drive/', '/OneDrive/', '/iCloud'];
  if (risky.some((r) => file.includes(r))) {
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
  return { sizeBytes: pageCount * pageSize, tables };
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
