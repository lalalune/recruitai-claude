/**
 * Database integration tests — real SQLite files, real migration, real triggers.
 *
 * Nothing here is mocked. Every guarantee the rest of the app leans on
 * (FTS staying in sync, foreign keys cascading, the api_call idempotency key
 * making a double-charge impossible, the task claim being atomic) is a property
 * of the schema, and a property of the schema can only be tested by running it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openDb,
  all,
  get,
  run,
  tx,
  ulid,
  backup,
  dbStats,
  bulkLoadReqs,
  type Db,
} from '../../src/main/db/index.js';
import { enqueue, claim, reserveApiCall } from '../../src/main/pipeline/tasks.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Every table the schema declares, excluding FTS5 and its shadow tables. */
const BASE_TABLES = [
  'api_call',
  'audit_log',
  'company',
  'contact',
  'draft',
  'email_pattern',
  'field_observation',
  'field_resolved',
  'inbound',
  'raw_response',
  'req',
  'req_daily',
  'screenshot',
  'send',
  'setting',
  'spend_cap',
  'suppression',
  'task',
];

/**
 * req_fts plus the four shadow tables FTS5 creates for it
 * (_data, _idx, _docsize, _config).
 */
const FTS_TABLES = ['req_fts', 'req_fts_config', 'req_fts_data', 'req_fts_docsize', 'req_fts_idx'];

let tmpRoot = '';
let seq = 0;

function freshDbPath(name: string): string {
  return path.join(tmpRoot, `${name}-${seq++}.db`);
}

function freshDb(name: string): Db {
  return openDb(freshDbPath(name));
}

function tableNames(db: Db): string[] {
  return all<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((r) => r.name);
}

function reqTriggerNames(db: Db): string[] {
  return all<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'req_a%' ORDER BY name`,
  ).map((r) => r.name);
}

function seedCompany(db: Db, id: string, name: string, domain: string | null): string {
  run(
    db,
    `INSERT INTO company (id, domain, name, name_norm, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    domain,
    name,
    name.toLowerCase(),
    Date.now(),
    Date.now(),
  );
  return id;
}

function seedReq(
  db: Db,
  companyId: string,
  externalId: string,
  title: string,
  location: string | null,
  description: string | null,
): number {
  const row = get<{ id: number }>(
    db,
    `INSERT INTO req (company_id, external_id, source, title, location, description, url)
     VALUES (?, ?, 'greenhouse', ?, ?, ?, ?) RETURNING id`,
    companyId,
    externalId,
    title,
    location,
    description,
    `https://example.test/jobs/${externalId}`,
  );
  return row!.id;
}

function ftsMatch(db: Db, query: string): number[] {
  return all<{ rowid: number }>(db, `SELECT rowid FROM req_fts WHERE req_fts MATCH ? ORDER BY rowid`, query).map(
    (r) => r.rowid,
  );
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-db-test-'));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

/** Keep in lockstep with the MIGRATIONS list in src/main/db/index.ts. */
const CURRENT_SCHEMA_VERSION = 2;

describe('migration', () => {
  test('applies the schema from scratch and stamps user_version', () => {
    const db = freshDb('migrate');
    try {
      assert.equal(get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version, CURRENT_SCHEMA_VERSION);

      const names = tableNames(db);
      for (const t of BASE_TABLES) assert.ok(names.includes(t), `missing table: ${t}`);
      for (const t of FTS_TABLES) assert.ok(names.includes(t), `missing FTS table: ${t}`);

      // 18 declared tables + req_fts + its 4 shadow tables. Pinned so that adding
      // a table without a migration bump fails here rather than in production.
      assert.equal(names.length, BASE_TABLES.length + FTS_TABLES.length);
      assert.equal(names.length, 23);

      assert.deepEqual(reqTriggerNames(db), ['req_ad', 'req_ai', 'req_au']);
    } finally {
      db.close();
    }
  });

  test('re-opening an existing database does not re-run the migration', () => {
    const file = freshDbPath('idempotent');

    const first = openDb(file);
    seedCompany(first, 'C_KEEP', 'Keepsake', 'keepsake.test');
    first.close();

    // A second application of schema.sql would throw "table company already
    // exists"; surviving data proves the guard, not just a silent no-op.
    const second = openDb(file);
    try {
      assert.equal(get<{ user_version: number }>(second, 'PRAGMA user_version')?.user_version, CURRENT_SCHEMA_VERSION);
      assert.equal(get<{ n: number }>(second, 'SELECT count(*) AS n FROM company')?.n, 1);
      assert.equal(get<{ name: string }>(second, 'SELECT name FROM company WHERE id = ?', 'C_KEEP')?.name, 'Keepsake');
    } finally {
      second.close();
    }
  });

  test('applies the PRAGMAs the app depends on', () => {
    const db = freshDb('pragmas');
    try {
      assert.equal(get<{ journal_mode: string }>(db, 'PRAGMA journal_mode')?.journal_mode, 'wal');
      assert.equal(get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')?.foreign_keys, 1);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('full-text search', () => {
  test('triggers keep req_fts in sync across insert, update and delete', () => {
    const db = freshDb('fts');
    try {
      seedCompany(db, 'C_FTS', 'FTS Co', 'fts.test');
      const backendId = seedReq(db, 'C_FTS', 'j1', 'Staff Backend Engineer', 'San Francisco, CA', 'Rust and Postgres.');
      const designId = seedReq(db, 'C_FTS', 'j2', 'Product Designer', 'Oakland, CA', 'Figma all day.');

      assert.deepEqual(ftsMatch(db, 'backend'), [backendId]);
      assert.deepEqual(ftsMatch(db, 'rust'), [backendId]);
      assert.deepEqual(ftsMatch(db, 'designer'), [designId]);
      assert.deepEqual(ftsMatch(db, 'oakland'), [designId]);

      run(db, `UPDATE req SET title = ?, description = ? WHERE id = ?`, 'Staff Frontend Engineer', 'TypeScript and React.', backendId);
      assert.deepEqual(ftsMatch(db, 'backend'), [], 'stale term still indexed after UPDATE');
      assert.deepEqual(ftsMatch(db, 'rust'), [], 'stale description still indexed after UPDATE');
      assert.deepEqual(ftsMatch(db, 'frontend'), [backendId]);
      assert.deepEqual(ftsMatch(db, 'typescript'), [backendId]);

      run(db, 'DELETE FROM req WHERE id = ?', backendId);
      assert.deepEqual(ftsMatch(db, 'frontend'), [], 'deleted row still indexed');
      assert.deepEqual(ftsMatch(db, 'designer'), [designId], 'unrelated row lost from the index');

      // The FTS integrity check is what actually catches a desynced external-content
      // index; a MATCH query can look fine while the index is quietly corrupt.
      db.exec("INSERT INTO req_fts(req_fts, rank) VALUES('integrity-check', 1)");
    } finally {
      db.close();
    }
  });

  test('bulkLoadReqs drops the triggers, rebuilds them, and leaves FTS queryable', () => {
    const db = freshDb('bulk');
    try {
      seedCompany(db, 'C_BULK', 'Bulk Co', 'bulk.test');
      assert.deepEqual(reqTriggerNames(db), ['req_ad', 'req_ai', 'req_au']);

      const ids: number[] = [];
      bulkLoadReqs(db, () => {
        assert.deepEqual(reqTriggerNames(db), [], 'triggers should be dropped for the bulk load');
        tx(db, () => {
          for (let i = 0; i < 200; i++) {
            ids.push(seedReq(db, 'C_BULK', `b${i}`, `Distributed Systems Engineer ${i}`, 'Palo Alto, CA', 'Kubernetes.'));
          }
        });
      });

      assert.deepEqual(reqTriggerNames(db), ['req_ad', 'req_ai', 'req_au'], 'triggers were not rebuilt');
      assert.equal(ftsMatch(db, 'kubernetes').length, 200, 'rebuild did not index the bulk-loaded rows');

      // And the rebuilt triggers still work for subsequent writes.
      const later = seedReq(db, 'C_BULK', 'after', 'Compiler Engineer', 'Berkeley, CA', 'LLVM work.');
      assert.deepEqual(ftsMatch(db, 'llvm'), [later]);

      db.exec("INSERT INTO req_fts(req_fts, rank) VALUES('integrity-check', 1)");
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('constraints', () => {
  test('deleting a company cascades to its reqs and contacts', () => {
    const db = freshDb('cascade');
    try {
      seedCompany(db, 'C_DEL', 'Doomed', 'doomed.test');
      seedCompany(db, 'C_KEEP', 'Survivor', 'survivor.test');
      seedReq(db, 'C_DEL', 'r1', 'Backend Engineer', 'SF', null);
      seedReq(db, 'C_KEEP', 'r1', 'Backend Engineer', 'SF', null);
      run(
        db,
        `INSERT INTO contact (id, company_id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        'CT_DEL',
        'C_DEL',
        'Doomed Person',
        Date.now(),
        Date.now(),
      );

      run(db, 'DELETE FROM company WHERE id = ?', 'C_DEL');

      assert.equal(get<{ n: number }>(db, `SELECT count(*) AS n FROM req WHERE company_id = 'C_DEL'`)?.n, 0);
      assert.equal(get<{ n: number }>(db, `SELECT count(*) AS n FROM contact WHERE company_id = 'C_DEL'`)?.n, 0);
      assert.equal(get<{ n: number }>(db, `SELECT count(*) AS n FROM req WHERE company_id = 'C_KEEP'`)?.n, 1);
    } finally {
      db.close();
    }
  });

  test('a req referencing an unknown company is rejected', () => {
    const db = freshDb('fk');
    try {
      assert.throws(() => seedReq(db, 'C_GHOST', 'r1', 'Backend Engineer', null, null), /FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  test('CHECK constraints reject bad enum values', () => {
    const db = freshDb('checks');
    try {
      seedCompany(db, 'C_CHK', 'Checked', 'checked.test');

      assert.throws(
        () => run(db, 'UPDATE company SET status = ? WHERE id = ?', 'totally_not_a_status', 'C_CHK'),
        /CHECK constraint failed/i,
      );
      // …and the legal values still pass, so the test isn't just asserting that
      // every write fails.
      run(db, 'UPDATE company SET status = ? WHERE id = ?', 'approved', 'C_CHK');

      assert.throws(
        () =>
          run(
            db,
            `INSERT INTO contact (id, company_id, full_name, email_verdict, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            'CT_BAD',
            'C_CHK',
            'Bad Verdict',
            'probably_fine',
            Date.now(),
            Date.now(),
          ),
        /CHECK constraint failed/i,
      );

      assert.throws(
        () => run(db, `INSERT INTO suppression (kind, value, reason) VALUES ('domain', 'x.test', 'vibes')`),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () => run(db, `INSERT INTO suppression (kind, value, reason) VALUES ('telepathy', 'x.test', 'manual')`),
        /CHECK constraint failed/i,
      );
      run(db, `INSERT INTO suppression (kind, value, reason) VALUES ('domain', 'x.test', 'existing_client')`);
    } finally {
      db.close();
    }
  });

  /**
   * The anti-blowup guarantee. reserveApiCall writes this row BEFORE the HTTP
   * request, so if the UNIQUE constraint ever stops holding, a retry loop can
   * bill the same entity an unbounded number of times.
   */
  test('api_call UNIQUE(provider, idempotency_key) makes a double charge impossible', () => {
    const db = freshDb('idem');
    try {
      run(
        db,
        `INSERT INTO api_call (provider, endpoint, idempotency_key, est_cost_micros) VALUES (?, ?, ?, ?)`,
        'reoon',
        '/verify',
        'verify:ada@acme.test',
        8000,
      );

      assert.throws(
        () =>
          run(
            db,
            `INSERT INTO api_call (provider, endpoint, idempotency_key, est_cost_micros) VALUES (?, ?, ?, ?)`,
            'reoon',
            '/verify',
            'verify:ada@acme.test',
            8000,
          ),
        /UNIQUE constraint failed/i,
      );

      // A different provider with the same key is a genuinely different call.
      run(
        db,
        `INSERT INTO api_call (provider, endpoint, idempotency_key, est_cost_micros) VALUES (?, ?, ?, ?)`,
        'bouncer',
        '/verify',
        'verify:ada@acme.test',
        8000,
      );
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM api_call')?.n, 2);

      // And the reservation helper degrades to null rather than throwing, which
      // is what lets a caller skip the request instead of crashing the run.
      const first = reserveApiCall(db, {
        provider: 'reoon',
        endpoint: '/verify',
        idempotencyKey: 'verify:grace@acme.test',
        estCostMicros: 8000,
      });
      assert.ok(first);
      const second = reserveApiCall(db, {
        provider: 'reoon',
        endpoint: '/verify',
        idempotencyKey: 'verify:grace@acme.test',
        estCostMicros: 8000,
      });
      assert.equal(second, null, 'a repeated reservation must not create a second billable row');
      assert.equal(
        get<{ n: number }>(db, `SELECT count(*) AS n FROM api_call WHERE idempotency_key = 'verify:grace@acme.test'`)?.n,
        1,
      );
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('task queue', () => {
  /**
   * Two independent connections to the same file, interleaved. That is the real
   * topology (main process + worker), and the only thing standing between them
   * is that `UPDATE ... WHERE id = (SELECT ...) RETURNING *` is atomic.
   */
  test('the claim is race-free across connections', () => {
    const file = freshDbPath('claim');
    const a = openDb(file);
    const b = openDb(file);
    try {
      const TOTAL = 60;
      tx(a, () => {
        for (let i = 0; i < TOTAL; i++) enqueue(a, 'probe', { i }, { dedupeKey: `probe:${i}`, priority: i });
      });
      assert.equal(get<{ n: number }>(a, `SELECT count(*) AS n FROM task WHERE state = 'pending'`)?.n, TOTAL);

      const claimed: number[] = [];
      const seen = new Set<number>();
      let connection = 0;
      for (;;) {
        const db = connection++ % 2 === 0 ? a : b;
        const task = claim(db);
        if (!task) {
          // Only stop once BOTH connections agree there is nothing left.
          const other = claim(connection % 2 === 0 ? a : b);
          if (!other) break;
          assert.ok(!seen.has(other.id), `task ${other.id} was claimed twice`);
          seen.add(other.id);
          claimed.push(other.id);
          continue;
        }
        assert.ok(!seen.has(task.id), `task ${task.id} was claimed twice`);
        seen.add(task.id);
        claimed.push(task.id);
      }

      assert.equal(claimed.length, TOTAL, 'every task must be claimed exactly once');
      assert.equal(seen.size, TOTAL);
      assert.equal(get<{ n: number }>(a, `SELECT count(*) AS n FROM task WHERE state = 'running'`)?.n, TOTAL);
      assert.equal(get<{ n: number }>(a, `SELECT count(*) AS n FROM task WHERE attempts != 1`)?.n, 0);

      // priority ordering is part of the claim contract
      assert.deepEqual(
        claimed.slice(0, 5),
        all<{ id: number }>(a, 'SELECT id FROM task ORDER BY priority, id LIMIT 5').map((r) => r.id),
      );
    } finally {
      a.close();
      b.close();
    }
  });

  test('dedupe_key blocks a duplicate while one is pending or running', () => {
    const db = freshDb('dedupe');
    try {
      const first = enqueue(db, 'verify', { email: 'ada@acme.test' }, { dedupeKey: 'ada@acme.test' });
      assert.ok(first);
      assert.equal(enqueue(db, 'verify', { email: 'ada@acme.test' }, { dedupeKey: 'ada@acme.test' }), null);

      const task = claim(db);
      assert.equal(task?.id, first);
      // Still blocked while running — that is the point of the partial index.
      assert.equal(enqueue(db, 'verify', { email: 'ada@acme.test' }, { dedupeKey: 'ada@acme.test' }), null);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ulid', () => {
  test('is monotonic within one millisecond and lexicographically sortable', () => {
    const t = 1_800_000_000_000;

    const sameMs = Array.from({ length: 500 }, () => ulid(t));
    for (const id of sameMs) assert.equal(id.length, 26);
    for (let i = 1; i < sameMs.length; i++) {
      assert.ok(sameMs[i]! > sameMs[i - 1]!, `ulid went backwards within the same ms at index ${i}`);
    }
    assert.equal(new Set(sameMs).size, sameMs.length);

    // The 10-char time prefix means byte order is time order across milliseconds.
    const earlier = ulid(t);
    const later = ulid(t + 1);
    const muchLater = ulid(t + 86_400_000);
    assert.ok(later > earlier);
    assert.ok(muchLater > later);
    assert.equal(earlier.slice(0, 10), sameMs[0]!.slice(0, 10));

    // Sorting ULIDs as text must equal sorting them by generation order.
    const stream = [ulid(t + 10), ulid(t + 10), ulid(t + 11), ulid(t + 12), ulid(t + 12)];
    assert.deepEqual([...stream].sort(), stream);
  });

  test('sorts correctly as a SQLite TEXT primary key', () => {
    const db = freshDb('ulid-sort');
    try {
      const ids = Array.from({ length: 50 }, (_, i) => ulid(1_800_000_000_000 + Math.floor(i / 5)));
      tx(db, () => {
        for (const [i, id] of ids.entries()) seedCompany(db, id, `Company ${i}`, `co-${i}.test`);
      });
      const ordered = all<{ id: string }>(db, 'SELECT id FROM company ORDER BY id').map((r) => r.id);
      assert.deepEqual(ordered, ids);
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('backup', () => {
  test('VACUUM INTO produces a readable copy with identical row counts', () => {
    const db = freshDb('backup-src');
    const dest = path.join(tmpRoot, 'backup-copy.db');
    try {
      tx(db, () => {
        seedCompany(db, 'C_B1', 'Backup One', 'backupone.test');
        seedCompany(db, 'C_B2', 'Backup Two', 'backuptwo.test');
        for (let i = 0; i < 25; i++) seedReq(db, 'C_B1', `bk${i}`, `Backend Engineer ${i}`, 'SF', 'Go and gRPC.');
        run(db, `INSERT INTO suppression (kind, value, reason) VALUES ('domain', 'nope.test', 'competitor')`);
        run(db, `INSERT INTO setting (key, value) VALUES ('icp.staleDays', '45')`);
      });

      const sourceStats = dbStats(db);
      backup(db, dest);
      assert.ok(fs.existsSync(dest), 'backup file was not created');

      const copy = openDb(dest);
      try {
        assert.equal(get<{ user_version: number }>(copy, 'PRAGMA user_version')?.user_version, CURRENT_SCHEMA_VERSION);
        assert.deepEqual(dbStats(copy).tables, sourceStats.tables);
        assert.equal(get<{ n: number }>(copy, 'SELECT count(*) AS n FROM req')?.n, 25);
        assert.equal(
          get<{ name: string }>(copy, 'SELECT name FROM company WHERE id = ?', 'C_B1')?.name,
          'Backup One',
        );
        // FTS survives the copy, so a restored backup is immediately searchable.
        assert.equal(ftsMatch(copy, 'grpc').length, 25);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });
});
