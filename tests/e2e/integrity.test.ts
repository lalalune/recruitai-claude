/**
 * Database and verification integrity.
 *
 * These are the invariants that cost money or lose data when they break, so
 * every one is exercised against a real SQLite file and the real code path:
 *
 *   * a database from a NEWER build must be refused, never opened and written
 *     into under a schema this build does not understand;
 *   * two processes opening the same database at the same moment must both
 *     succeed — measured 24-of-48 failures before the fix;
 *   * a crash between reserving and committing a paid call must never allow a
 *     second charge, and the orphaned reservation must still count against the
 *     spend cap;
 *   * a provider error that consumed no credit must not lock the address out of
 *     verification forever;
 *   * a transient DNS failure must not be cached as a fact about the domain.
 */

// Must come first: patches require('electron').
import { installElectronStub } from './electron-stub.js';

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import {
  openDb,
  SCHEMA_VERSION,
  all,
  get,
  run,
  tx,
  ulid,
  backup,
  dbStats,
  isSyncedFolder,
  type Db,
} from '../../src/main/db/index.js';

installElectronStub();

/**
 * This file is its own worker script for the concurrent-open test below. The
 * branch has to run before node:test registers anything, so it sits above the
 * import that pulls node:test in.
 */
if (!isMainThread && (workerData as { raceFile?: string } | null)?.raceFile) {
  const { raceFile, startAt } = workerData as { raceFile: string; startAt: number };
  // Busy-wait to a shared instant: a timer would spread the workers out and
  // the collision is the entire point.
  while (Date.now() < startAt) {
    /* intentionally empty */
  }
  try {
    openDb(raceFile).close();
    process.exit(0);
  } catch (err) {
    console.error('[race worker]', err);
    process.exit(1);
  }
}

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COST_MICROS,
  GLOBAL_CAP_PROVIDER,
  SpendCapError,
  assertSpendAvailable,
  outstandingReservedMicros,
  syncSpendCap,
  totalSpentMicros,
  __reserveApiCallForTests as reserveApiCall,
  __commitApiCallForTests as commitApiCall,
} from '../../src/main/verify/verifier.js';
import { clearMxMemoryCache, lookupDomainMx, prefilter, type DomainMxInfo } from '../../src/main/verify/mx.js';
import { seedsFromDb } from '../../src/main/verify/pattern.js';

let tmpRoot = '';
let seq = 0;

const freshPath = (name: string) => path.join(tmpRoot, `${name}-${seq++}.db`);

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-integrity-'));
});

after(() => {
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leaked CI tmpdir must not fail the suite (same stance as db.test.ts) */
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describe('migration safety', () => {
  test('a database written by a NEWER build is refused, and left intact', () => {
    const file = freshPath('future');
    const db = openDb(file);
    run(db, `INSERT INTO company (id, name, name_norm) VALUES ('C_FUT', 'Future Co', 'future co')`);
    // Stand in for a v(N+1) build having been here first.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    assert.throws(
      () => openDb(file),
      (err: Error) => /newer version/i.test(err.message) && err.message.includes(`v${SCHEMA_VERSION}`),
      'an older build must refuse a newer schema rather than write into it',
    );

    // Refusing must be inert: no half-applied anything, no lost rows.
    const raw = new DatabaseSync(file);
    try {
      assert.equal(
        (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SCHEMA_VERSION + 1,
        'the version marker must be left exactly as the newer build wrote it',
      );
      assert.equal((raw.prepare(`SELECT name FROM company WHERE id = 'C_FUT'`).get() as { name: string }).name, 'Future Co');
    } finally {
      raw.close();
    }
  });

  test('the current version is a clean no-op and a fresh file migrates all the way up', () => {
    const file = freshPath('idempotent');
    const first = openDb(file);
    assert.equal(get<{ user_version: number }>(first, 'PRAGMA user_version')?.user_version, SCHEMA_VERSION);
    run(first, `INSERT INTO company (id, name, name_norm) VALUES ('C_IDEM', 'Idem', 'idem')`);
    first.close();

    // Re-applying schema.sql would throw "table company already exists";
    // surviving data proves the guard rather than a silent no-op.
    const second = openDb(file);
    try {
      assert.equal(get<{ user_version: number }>(second, 'PRAGMA user_version')?.user_version, SCHEMA_VERSION);
      assert.equal(get<{ n: number }>(second, 'SELECT count(*) AS n FROM company')?.n, 1);
    } finally {
      second.close();
    }
  });

  /**
   * The whole partial-migration story rests on user_version being part of the
   * transaction. If it were not, a migration that failed halfway would leave a
   * stamped version sitting on top of unapplied DDL — silently, forever.
   */
  test('PRAGMA user_version is transactional, so a failed migration cannot stamp itself', () => {
    const db = openDb(freshPath('uv-tx'));
    try {
      const before = get<{ user_version: number }>(db, 'PRAGMA user_version')!.user_version;
      db.exec('BEGIN IMMEDIATE');
      db.exec('PRAGMA user_version = 9999');
      db.exec('ROLLBACK');
      assert.equal(get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version, before);
    } finally {
      db.close();
    }
  });

  test('a failed migration rolls back every statement in the same script', () => {
    // The shape migrate() uses: several statements in one exec() inside one
    // transaction, with a later one bad.
    const db = openDb(freshPath('partial'));
    try {
      db.exec('BEGIN IMMEDIATE');
      let threw = false;
      try {
        db.exec(`
          CREATE TABLE probe_a (x INTEGER);
          CREATE TABLE probe_b (x INTEGER);
          CREATE TABLE company (x INTEGER);
        `);
      } catch {
        threw = true;
        db.exec('ROLLBACK');
      }
      assert.ok(threw, 'the duplicate table should have failed');
      assert.deepEqual(
        all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE name IN ('probe_a','probe_b')`),
        [],
        'earlier statements in the same exec must roll back too',
      );
    } finally {
      db.close();
    }
  });

  /**
   * Two processes starting together — the app and `bun run seed`, or two
   * launches on a cold install. Before the fix this failed 24 times out of 48
   * with "table company already exists", "duplicate column name: follow_up_of"
   * and "database is locked": the app simply would not start.
   */
  test('six connections opening the same brand-new database concurrently all succeed', async () => {
    const file = freshPath('race');
    const startAt = Date.now() + 250;
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<number>((resolve, reject) => {
            const w = new Worker(workerScript(), { workerData: { raceFile: file, startAt } });
            w.on('error', reject);
            w.on('exit', resolve);
          }),
      ),
    );
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], 'every concurrent open must succeed');

    const db = openDb(file);
    try {
      assert.equal(get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version, SCHEMA_VERSION);
      // A torn migration shows up here as a missing table or a missing column.
      run(db, `INSERT INTO company (id, name, name_norm, ats_miss_count) VALUES ('C_RACE', 'Race', 'race', 0)`);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 1);
      db.exec("INSERT INTO req_fts(req_fts, rank) VALUES('integrity-check', 1)");
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('every connection enforces the schema', () => {
  test('foreign keys, WAL and busy_timeout hold on a second connection to the same file', () => {
    const file = freshPath('pragmas');
    const a = openDb(file);
    const b = openDb(file);
    try {
      for (const [label, db] of [
        ['first', a],
        ['second', b],
      ] as const) {
        assert.equal(get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys, 1, label);
        assert.equal(get<{ journal_mode: string }>(db, 'PRAGMA journal_mode')?.journal_mode, 'wal', label);
        assert.ok((get<{ timeout: number }>(db, 'PRAGMA busy_timeout')?.timeout ?? 0) >= 5000, label);
      }
      // Enforcement, not just the pragma's reported value.
      assert.throws(
        () =>
          run(
            b,
            `INSERT INTO req (company_id, external_id, source, title, url)
             VALUES ('C_NOPE', 'x', 'greenhouse', 'Engineer', 'https://x.test')`,
          ),
        /FOREIGN KEY/i,
      );
    } finally {
      a.close();
      b.close();
    }
  });

  test('a backup copy is a full database — same version, same constraints, same index', () => {
    const src = openDb(freshPath('backup-src'));
    const dest = path.join(tmpRoot, `copy-${seq++}.db`);
    try {
      tx(src, () => {
        run(src, `INSERT INTO company (id, domain, name, name_norm) VALUES ('C_BK', 'bk.test', 'Backup', 'backup')`);
        run(
          src,
          `INSERT INTO req (company_id, external_id, source, title, location, description, url)
           VALUES ('C_BK', 'r1', 'greenhouse', 'Staff Backend Engineer', 'SF', 'Rust and gRPC.', 'https://x.test/1')`,
        );
      });
      const srcTables = dbStats(src).tables;
      backup(src, dest);

      const copy = openDb(dest);
      try {
        assert.equal(get<{ user_version: number }>(copy, 'PRAGMA user_version')?.user_version, SCHEMA_VERSION);
        assert.deepEqual(dbStats(copy).tables, srcTables);
        // The copy is not a dump: it enforces the same rules and it is indexed.
        assert.throws(
          () => run(copy, `UPDATE company SET status = 'nonsense' WHERE id = 'C_BK'`),
          /CHECK constraint failed/i,
        );
        assert.equal(all<{ rowid: number }>(copy, `SELECT rowid FROM req_fts WHERE req_fts MATCH 'grpc'`).length, 1);
      } finally {
        copy.close();
      }
    } finally {
      src.close();
    }
  });

  test('dbStats reports every base table and counts uncheckpointed WAL bytes', () => {
    const db = openDb(freshPath('stats'));
    try {
      const stats = dbStats(db);
      for (const t of ['company', 'req', 'contact', 'api_call', 'spend_cap', 'raw_response']) {
        assert.ok(t in stats.tables, `dbStats omitted ${t}`);
      }
      assert.ok(!('req_fts' in stats.tables), 'FTS shadow tables are not base tables');

      const before = stats.sizeBytes;
      tx(db, () => {
        for (let i = 0; i < 500; i++) {
          run(
            db,
            `INSERT INTO company (id, domain, name, name_norm) VALUES (?, ?, ?, ?)`,
            `C${i}`,
            `d${i}.test`,
            `Name ${i}`,
            `name ${i}`,
          );
        }
      });
      const after = dbStats(db);
      assert.equal(after.tables.company, 500);
      assert.ok(after.sizeBytes > before, 'reported size did not grow after 500 inserts');

      // Committed rows that have not been checkpointed yet live only in the
      // -wal, and page_count cannot see them. Whatever the file holds must be
      // in the number the operator is shown.
      const file = get<{ file: string }>(db, `SELECT file FROM pragma_database_list WHERE name = 'main'`)!.file;
      const wal = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;
      assert.ok(wal > 0, 'expected uncheckpointed WAL bytes for this test to mean anything');
      const pages =
        get<{ page_count: number }>(db, 'PRAGMA page_count')!.page_count *
        get<{ page_size: number }>(db, 'PRAGMA page_size')!.page_size;
      assert.equal(dbStats(db).sizeBytes, pages + wal, 'sizeBytes must include the WAL, not just the main file');
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cost ledger', () => {
  const PROVIDER = 'reoon';
  const UNIT = COST_MICROS.reoon;

  function ledgerDb(name: string): Db {
    const db = openDb(freshPath(name));
    syncSpendCap(db, PROVIDER, 100 * 1_000_000);
    return db;
  }

  test('a crash between reserve and commit cannot double-charge on restart', () => {
    const file = freshPath('crash');
    const first = openDb(file);
    const key = 'ada@crash.test';
    const reserved = reserveApiCall(first, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
    assert.ok(reserved.id != null, 'the first reservation must succeed');
    // kill -9 here: the row stays 'reserved', the provider may or may not have
    // metered the credit, and nothing committed.
    first.close();

    const restarted = openDb(file);
    try {
      const again = reserveApiCall(restarted, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      assert.equal(again.id, null, 'a stuck reservation must block, not re-charge');
      assert.equal(again.blockedBy?.state, 'reserved');
      assert.equal(
        get<{ n: number }>(restarted, 'SELECT count(*) AS n FROM api_call WHERE idempotency_key = ?', key)?.n,
        1,
        'exactly one billable row may exist for one key',
      );
    } finally {
      restarted.close();
    }
  });

  test('a reservation orphaned by a crash still counts against the spend cap', () => {
    const db = ledgerDb('orphan-cap');
    try {
      const cap = UNIT * 3;
      assert.equal(outstandingReservedMicros(db), 0);

      for (const key of ['a@cap.test', 'b@cap.test', 'c@cap.test']) {
        reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      }
      assert.equal(outstandingReservedMicros(db), UNIT * 3);
      // spend_cap has not moved — nothing committed — so a ceiling that only
      // looked there would happily authorise three more credits.
      assert.equal(totalSpentMicros(db), 0);

      assert.throws(
        () => assertSpendAvailable(db, PROVIDER, UNIT, cap),
        SpendCapError,
        'money already in flight must count against the ceiling',
      );
    } finally {
      db.close();
    }
  });

  test('committed spend and in-flight reservations are counted together, once each', () => {
    const db = ledgerDb('cap-sum');
    try {
      const r = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key: 'paid@cap.test', estCostMicros: UNIT });
      commitApiCall(db, r.id!, { state: 'succeeded', httpStatus: 200, costMicros: UNIT });
      run(db, 'UPDATE spend_cap SET spent_usd_micros = spent_usd_micros + ? WHERE provider = ?', UNIT, PROVIDER);

      // A committed row is no longer outstanding, so it is not counted twice.
      assert.equal(outstandingReservedMicros(db), 0);
      assert.equal(totalSpentMicros(db), UNIT);

      reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key: 'inflight@cap.test', estCostMicros: UNIT });
      assert.equal(outstandingReservedMicros(db), UNIT);

      // Ceiling of exactly two credits: both are accounted for, so a third is refused.
      assert.throws(() => assertSpendAvailable(db, PROVIDER, UNIT, UNIT * 2), SpendCapError);
      // …and one more credit of headroom is enough.
      assertSpendAvailable(db, PROVIDER, UNIT, UNIT * 3);
    } finally {
      db.close();
    }
  });

  test('the ceiling-only "all" row is never mistaken for spend', () => {
    const db = ledgerDb('all-row');
    try {
      run(db, 'UPDATE spend_cap SET spent_usd_micros = ? WHERE provider = ?', 999_000_000, GLOBAL_CAP_PROVIDER);
      assert.equal(totalSpentMicros(db), 0, 'the cap row must not be summed as spend');
    } finally {
      db.close();
    }
  });

  /**
   * Reoon, Bouncer and MillionVerifier all answer "invalid API key",
   * "unparseable body" and "no task id" with HTTP 200 plus an error field, and
   * they meter none of them. Judging retryability by status alone left the
   * address permanently un-verifiable: one wrong key poisoned every address it
   * touched, and only a manual force could ever pay again.
   */
  test('a provider error that cost nothing frees the key for a retry', () => {
    const db = ledgerDb('zero-cost-retry');
    try {
      const key = 'ada@keyerror.test';
      const first = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      commitApiCall(db, first.id!, {
        state: 'failed',
        httpStatus: 200,
        costMicros: 0,
        error: 'reoon: invalid API key',
      });

      const retry = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      assert.equal(retry.id, first.id, 'the retry must reuse the same unpaid ledger row');
      assert.equal(get<{ state: string }>(db, 'SELECT state FROM api_call WHERE id = ?', first.id)?.state, 'reserved');
      assert.equal(
        get<{ n: number }>(db, 'SELECT count(*) AS n FROM api_call WHERE idempotency_key = ?', key)?.n,
        1,
        'reuse must not mint a second billable row',
      );
    } finally {
      db.close();
    }
  });

  test('a failure that DID cost a credit stays blocked', () => {
    const db = ledgerDb('paid-failure');
    try {
      const key = 'ada@charged.test';
      const first = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      // Charged, then something downstream went wrong. The credit is gone.
      commitApiCall(db, first.id!, { state: 'failed', httpStatus: 200, costMicros: UNIT, error: 'bulk task timed out' });

      const retry = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      assert.equal(retry.id, null, 'a metered attempt must never be silently repaid');
      assert.equal(retry.blockedBy?.state, 'failed');
    } finally {
      db.close();
    }
  });

  test('a network-level failure with no status is retryable and clears its stale cost', () => {
    const db = ledgerDb('network-failure');
    try {
      const key = 'ada@offline.test';
      const first = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      commitApiCall(db, first.id!, { state: 'failed', httpStatus: null, costMicros: 0, error: 'ECONNRESET' });

      const retry = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      assert.equal(retry.id, first.id);
      assert.equal(
        get<{ c: number | null }>(db, 'SELECT actual_cost_micros AS c FROM api_call WHERE id = ?', first.id)?.c,
        null,
        'an in-flight retry must not read as a settled zero-cost call',
      );
    } finally {
      db.close();
    }
  });

  test('a succeeded row is never reused, whatever it cost', () => {
    const db = ledgerDb('succeeded');
    try {
      const key = 'ada@done.test';
      const first = reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT });
      // Bouncer does not bill unknowns, so a zero-cost SUCCESS is real — and it
      // still must not be replayed, because the answer is already cached.
      commitApiCall(db, first.id!, { state: 'succeeded', httpStatus: 200, costMicros: 0 });
      assert.equal(reserveApiCall(db, { provider: PROVIDER, endpoint: 'verify', key, estCostMicros: UNIT }).id, null);
    } finally {
      db.close();
    }
  });

  test('costs stay integer micros — a fractional cost is rejected at the column', () => {
    const db = ledgerDb('micros');
    try {
      assert.throws(
        () =>
          run(
            db,
            `INSERT INTO api_call (provider, endpoint, idempotency_key, est_cost_micros) VALUES (?, ?, ?, ?)`,
            PROVIDER,
            'verify',
            'float@micros.test',
            1190.5,
          ),
        /datatype mismatch|cannot store/i,
        'STRICT must refuse a float into an INTEGER micros column',
      );
      assert.throws(
        () => run(db, 'UPDATE spend_cap SET spent_usd_micros = ? WHERE provider = ?', 0.5, PROVIDER),
        /datatype mismatch|cannot store/i,
      );
      // A whole-number double is the same integer, so ordinary arithmetic is fine.
      run(db, 'UPDATE spend_cap SET spent_usd_micros = ? WHERE provider = ?', 1190 * 3, PROVIDER);
      assert.equal(totalSpentMicros(db), 3570);
    } finally {
      db.close();
    }
  });

  test('timestamps stay epoch-millisecond integers', () => {
    const db = openDb(freshPath('timestamps'));
    try {
      run(db, `INSERT INTO company (id, name, name_norm) VALUES ('C_TS', 'Time Co', 'time co')`);
      assert.throws(
        () => run(db, `UPDATE company SET reviewed_at = ? WHERE id = 'C_TS'`, new Date().toISOString()),
        /datatype mismatch|cannot store/i,
        'an ISO string must not land in an epoch-ms INTEGER column',
      );

      // The schema default and Date.now() must agree on the unit, or the UI
      // renders "reviewed 55 years ago".
      const defaults = get<{ created_at: number; updated_at: number }>(
        db,
        `SELECT created_at, updated_at FROM company WHERE id = 'C_TS'`,
      )!;
      const now = Date.now();
      assert.ok(Math.abs(defaults.created_at - now) < 60_000, `created_at ${defaults.created_at} is not epoch ms`);
      assert.ok(Math.abs(defaults.updated_at - now) < 60_000, `updated_at ${defaults.updated_at} is not epoch ms`);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MX prefilter caching', () => {
  const info = (over: Partial<DomainMxInfo>): DomainMxInfo => ({
    domain: 'x.test',
    provider: 'unknown',
    hosts: [],
    hasAddressRecord: false,
    nxdomain: false,
    transient: false,
    resolvedAt: Date.now(),
    cached: false,
    ...over,
  });

  test('a transient DNS failure is cached nowhere — the next lookup retries', async () => {
    const db = openDb(freshPath('mx-transient'));
    clearMxMemoryCache();
    try {
      let calls = 0;
      const flaky = async (domain: string): Promise<DomainMxInfo> => {
        calls++;
        return calls === 1
          ? info({ domain, transient: true, provider: 'unknown' })
          : info({ domain, provider: 'google', hosts: ['aspmx.l.google.com'] });
      };

      const first = await lookupDomainMx(db, 'flaky.test', { resolve: flaky });
      assert.equal(first.transient, true);
      assert.equal(
        get<{ n: number }>(db, `SELECT count(*) AS n FROM email_pattern WHERE domain = 'flaky.test'`)?.n,
        0,
        'a transient failure must not be written to the durable cache',
      );

      // Before the fix this returned the memoised transient result forever, so
      // every address at the domain was skipped for the life of the process.
      const second = await lookupDomainMx(db, 'flaky.test', { resolve: flaky });
      assert.equal(calls, 2, 'the second lookup must actually re-resolve');
      assert.equal(second.transient, false);
      assert.equal(second.provider, 'google');
    } finally {
      db.close();
    }
  });

  test('a resolved answer IS cached, in memory and on disk', async () => {
    const db = openDb(freshPath('mx-cached'));
    clearMxMemoryCache();
    try {
      let calls = 0;
      const once = async (domain: string): Promise<DomainMxInfo> => {
        calls++;
        return info({ domain, provider: 'google', hosts: ['aspmx.l.google.com'] });
      };
      await lookupDomainMx(db, 'stable.test', { resolve: once });
      await lookupDomainMx(db, 'stable.test', { resolve: once });
      assert.equal(calls, 1, 'a settled answer must not be re-resolved');
      assert.equal(
        get<{ p: string }>(db, `SELECT mx_provider AS p FROM email_pattern WHERE domain = 'stable.test'`)?.p,
        'google',
      );
    } finally {
      db.close();
    }
  });

  test('a transient failure is reported as retryable, never as a dead domain', async () => {
    const db = openDb(freshPath('mx-prefilter'));
    clearMxMemoryCache();
    try {
      const pre = await prefilter(db, 'ada@downdns.test', {
        resolve: async (domain) => info({ domain, transient: true }),
      });
      assert.equal(pre.verdict, null, 'DNS being unreachable is not a verdict about the address');
      assert.equal(pre.worthVerifying, false);
      assert.match(pre.reason, /retry later/i);
    } finally {
      db.close();
    }
  });

  test('the free prefilter settles the cases that must never reach a paid call', async () => {
    const db = openDb(freshPath('mx-free'));
    clearMxMemoryCache();
    let resolverCalls = 0;
    const google = async (domain: string) => {
      resolverCalls++;
      return info({ domain, provider: 'google', hosts: ['aspmx.l.google.com'] });
    };
    try {
      assert.equal((await prefilter(db, 'not-an-address', { resolve: google })).verdict, 'invalid');

      const disposable = await prefilter(db, 'x@mailinator.com', { resolve: google });
      assert.equal(disposable.verdict, 'disposable');
      assert.equal(disposable.disposable, true);

      // Neither of those may have cost a DNS query, let alone a credit.
      assert.equal(resolverCalls, 0, 'syntax and disposable checks must precede DNS');

      const role = await prefilter(db, 'careers@acme.test', { resolve: google });
      assert.equal(role.verdict, 'role');
      assert.equal(role.worthVerifying, false, 'a role address is never worth a guessed credit');

      const dead = await prefilter(db, 'ada@gone.test', {
        resolve: async (domain) => info({ domain, provider: 'none', nxdomain: true }),
      });
      assert.equal(dead.verdict, 'invalid');
      assert.equal(dead.worthVerifying, false);

      const real = await prefilter(db, 'ada@acme.test', { resolve: google });
      assert.equal(real.verdict, null, 'a live personal address has no free verdict');
      assert.equal(real.worthVerifying, true, 'and it is the only kind worth paying for');
    } finally {
      db.close();
    }
  });

  test('a domain with no MX but an A record is not condemned', async () => {
    const db = openDb(freshPath('mx-arecord'));
    clearMxMemoryCache();
    try {
      const pre = await prefilter(db, 'ada@bare-a.test', {
        resolve: async (domain) => info({ domain, provider: 'none', hasAddressRecord: true, nxdomain: false }),
      });
      assert.notEqual(pre.verdict, 'invalid', 'RFC 5321 §5.1 makes a bare A record a mail destination');
      assert.equal(pre.worthVerifying, true);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('pattern seeds are found by index, not by scanning the database', () => {
  test('seeds are collected per domain from contacts and observations', () => {
    const db = openDb(freshPath('seeds'));
    try {
      tx(db, () => {
        for (const [i, domain] of ['acme.test', 'other.test'].entries()) {
          const companyId = `C_SEED_${i}`;
          run(db, `INSERT INTO company (id, domain, name, name_norm) VALUES (?, ?, ?, ?)`, companyId, domain, domain, domain);
          const contactId = ulid(1_800_000_000_000 + i);
          run(
            db,
            `INSERT INTO contact (id, company_id, full_name, first_name, last_name, email, email_verdict)
             VALUES (?, ?, ?, ?, ?, ?, 'valid')`,
            contactId,
            companyId,
            `Ada Lovelace ${i}`,
            'Ada',
            'Lovelace',
            `ada.lovelace@${domain}`,
          );
          // An observed address that never became its own contact row.
          run(
            db,
            `INSERT INTO field_observation (entity, entity_id, field, value, source)
             VALUES ('contact', ?, 'email', ?, 'careers_page')`,
            contactId,
            `A.Lovelace@${domain.toUpperCase()}`,
          );
        }
      });

      const seeds = seedsFromDb(db, 'acme.test');
      const found = seeds.map((s) => s.email.toLowerCase()).sort();
      assert.deepEqual(found, ['a.lovelace@acme.test', 'ada.lovelace@acme.test']);
      // Mixed case in the stored value must still match the domain, and the
      // other domain's seeds must not leak in.
      assert.ok(!found.some((e) => e.includes('other.test')));
      assert.equal(seedsFromDb(db, 'nobody.test').length, 0);
    } finally {
      db.close();
    }
  });

  test('both seed queries seek an index instead of scanning', () => {
    const db = openDb(freshPath('seeds-plan'));
    try {
      // Every plan line must be a SEARCH on the expression index. A SCAN here
      // means the query text and the index expression have drifted apart, and
      // the cost silently goes back to O(whole database) per company.
      const contactPlan = all<{ detail: string }>(
        db,
        `EXPLAIN QUERY PLAN
         SELECT first_name FROM contact
          WHERE email IS NOT NULL
            AND substr(lower(email), instr(lower(email), '@') + 1) = 'acme.test'`,
      ).map((r) => r.detail);
      assert.ok(
        contactPlan.some((d) => d.includes('contact_email_domain')),
        `contact seed lookup is not using its index: ${contactPlan.join(' | ')}`,
      );

      const obsPlan = all<{ detail: string }>(
        db,
        `EXPLAIN QUERY PLAN
         SELECT fo.value FROM field_observation fo
          WHERE fo.entity = 'contact' AND fo.field = 'email' AND fo.value IS NOT NULL
            AND substr(lower(fo.value), instr(lower(fo.value), '@') + 1) = 'acme.test'
            AND fo.source <> 'pattern_inference'`,
      ).map((r) => r.detail);
      assert.ok(
        obsPlan.some((d) => d.includes('fo_email_domain')),
        `observation seed lookup is not using its index: ${obsPlan.join(' | ')}`,
      );
    } finally {
      db.close();
    }
  });

  test('the verifier evidence cache lookup seeks too', () => {
    const db = openDb(freshPath('evidence-plan'));
    try {
      const plan = all<{ detail: string }>(
        db,
        `EXPLAIN QUERY PLAN
         SELECT id, body, encoding, fetched_at FROM raw_response
          WHERE source = ? AND url = ? ORDER BY fetched_at DESC LIMIT 1`,
        'verifier',
        'verify://reoon/ada@acme.test',
      ).map((r) => r.detail);
      // Without (source, url) a cache MISS — the common case for a new address
      // — walked every verdict ever stored.
      assert.ok(
        plan.some((d) => d.includes('raw_source_url')),
        `evidence cache lookup is not using its index: ${plan.join(' | ')}`,
      );
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the cloud-synced-folder warning actually fires', () => {
  test('it catches where the operator would really put this database', () => {
    for (const p of [
      // macOS 12.3+: every provider mounts under CloudStorage.
      '/Users/ada/Library/CloudStorage/GoogleDrive-ada@example.com/recruitAI/recruitai.db',
      '/Users/ada/Library/CloudStorage/OneDrive-Contoso/recruitai.db',
      '/Users/ada/Library/CloudStorage/Dropbox/recruitai.db',
      '/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/recruitai.db',
      '/Users/ada/Dropbox/recruitAI/recruitai.db',
      '/Volumes/GoogleDrive/My Drive/recruitai.db',
      // Windows, where backslashes made the old check dead code.
      'C:\\Users\\Ada\\OneDrive - Contoso\\recruitAI\\recruitai.db',
      'C:\\Users\\Ada\\Dropbox\\recruitai.db',
      'C:\\Users\\Ada\\iCloudDrive\\recruitai.db',
      // Case, because both macOS and Windows paths are case-insensitive.
      '/Users/ada/dropbox/recruitai.db',
    ]) {
      assert.equal(isSyncedFolder(p), true, `missed a synced folder: ${p}`);
    }
  });

  test('it does not cry wolf on ordinary locations', () => {
    for (const p of [
      '/Users/ada/Library/Application Support/recruitAI/recruitai.db',
      '/Users/ada/Desktop/recruitAI/data/recruitai.db',
      '/var/folders/tmp/recruitai-test/recruitai.db',
      'C:\\Users\\Ada\\AppData\\Roaming\\recruitAI\\recruitai.db',
      '/home/ada/.local/share/recruitAI/recruitai.db',
    ]) {
      assert.equal(isSyncedFolder(p), false, `false alarm on: ${p}`);
    }
  });
});

/**
 * The bundled copy of this very file, which the concurrent-open test re-runs as
 * a worker. Under `node --test` each file is executed as its own process, so
 * argv[1] is it.
 */
function workerScript(): string {
  return process.argv[1] ?? '';
}
