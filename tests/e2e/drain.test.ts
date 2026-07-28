/**
 * Task queue + drainer.
 *
 * This exists because Outreach tells the operator that approving a company
 * queues its first draft. That sentence is only true if enqueue, claim, the
 * dedupe constraint, retry/backoff and the dead-letter transition all work — so
 * these tests hold that promise to account.
 */

import { installElectronStub } from './electron-stub.js';
installElectronStub();

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, all, get, run, type Db } from '../../src/main/db/index.js';
import { enqueue, claim, complete, fail, requeueStale, taskCounts } from '../../src/main/pipeline/tasks.js';

let dir: string;
let db: Db;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-drain-'));
  db = openDb(path.join(dir, 'test.db'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

function reset(): void {
  run(db, 'DELETE FROM task');
}

describe('task queue', () => {
  test('enqueue then claim returns the task with its payload intact', () => {
    reset();
    const id = enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    assert.ok(id, 'enqueue should return a row id');

    const task = claim(db);
    assert.ok(task);
    assert.equal(task.kind, 'generate_draft');
    assert.equal(task.state, 'running');
    assert.equal(task.attempts, 1);
    assert.deepEqual(JSON.parse(task.payload), { companyId: 'C1' });
  });

  test('a claimed task is not claimable again', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    assert.ok(claim(db));
    assert.equal(claim(db), null, 'the only task was already claimed');
  });

  test('dedupe_key stops repeated approve/unapprove stacking duplicate work', () => {
    reset();
    const first = enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    const second = enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    assert.ok(first);
    assert.equal(second, null, 'the duplicate must be dropped, not queued');
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) n FROM task')!.n, 1);
  });

  test('a different company still enqueues while one is pending', () => {
    reset();
    assert.ok(enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' }));
    assert.ok(enqueue(db, 'generate_draft', { companyId: 'C2' }, { dedupeKey: 'C2' }));
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) n FROM task')!.n, 2);
  });

  test('the dedupe key frees up once the task has completed', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    const t = claim(db)!;
    complete(db, t.id);
    // Re-approving later must be able to regenerate; the partial unique index
    // only covers pending/running.
    assert.ok(enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' }));
  });

  test('priority orders the queue ahead of insertion order', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'late' }, { dedupeKey: 'late', priority: 100 });
    enqueue(db, 'generate_draft', { companyId: 'urgent' }, { dedupeKey: 'urgent', priority: 10 });
    const first = claim(db)!;
    assert.equal(JSON.parse(first.payload).companyId, 'urgent');
  });

  test('run_after defers a task until its time arrives', () => {
    reset();
    const future = Date.now() + 60_000;
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1', runAfter: future });
    assert.equal(claim(db), null, 'not yet due');
    assert.ok(claim(db, future + 1), 'due once the clock passes run_after');
  });

  test('failure retries with backoff, then dead-letters at max_attempts', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1', maxAttempts: 3 });

    // Two failures should ask for a retry.
    for (let i = 0; i < 2; i++) {
      const t = claim(db, Date.now() + i * 3_600_000)!;
      assert.ok(t, `attempt ${i + 1} should be claimable`);
      assert.equal(fail(db, t.id, new Error('boom')), 'retry');
    }

    // The third exhausts the budget and buries it.
    const last = claim(db, Date.now() + 10 * 3_600_000)!;
    assert.ok(last);
    assert.equal(fail(db, last.id, new Error('boom')), 'dead');

    const dead = get<{ state: string; last_error: string }>(
      db, 'SELECT state, last_error FROM task WHERE id = ?', last.id,
    )!;
    assert.equal(dead.state, 'dead');
    assert.match(dead.last_error, /boom/);
    assert.equal(claim(db, Date.now() + 99 * 3_600_000), null, 'a dead task never runs again');
  });

  test('a failed task is not immediately re-claimable — backoff is real', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    const t = claim(db)!;
    fail(db, t.id, new Error('transient'));
    assert.equal(claim(db), null, 'backoff must push run_after into the future');
  });

  test('requeueStale recovers tasks left running by a crash', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    const t = claim(db)!;
    // Simulate the process dying mid-task.
    run(db, 'UPDATE task SET started_at = ? WHERE id = ?', Date.now() - 3_600_000, t.id);

    assert.equal(requeueStale(db, 60_000), 1);
    assert.ok(claim(db), 'the orphaned task is claimable again');
  });

  test('requeueStale leaves a task that is still legitimately running', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'C1' }, { dedupeKey: 'C1' });
    claim(db);
    assert.equal(requeueStale(db, 60_000), 0);
  });

  test('taskCounts reports each state', () => {
    reset();
    enqueue(db, 'generate_draft', { companyId: 'A' }, { dedupeKey: 'A' });
    enqueue(db, 'generate_draft', { companyId: 'B' }, { dedupeKey: 'B' });
    const t = claim(db)!;
    complete(db, t.id);

    const counts = taskCounts(db);
    assert.equal(counts.done, 1);
    assert.equal(counts.pending, 1);
  });

  test('payload must be valid JSON — the CHECK constraint holds', () => {
    reset();
    assert.throws(
      () => run(db, `INSERT INTO task (kind, payload) VALUES ('generate_draft', 'not json')`),
      /CHECK|constraint/i,
    );
  });

  test('state is constrained to the known set', () => {
    reset();
    assert.throws(
      () => run(db, `INSERT INTO task (kind, state) VALUES ('generate_draft', 'wat')`),
      /CHECK|constraint/i,
    );
  });

  test('claiming is atomic across two connections to the same file', () => {
    reset();
    for (let i = 0; i < 20; i++) {
      enqueue(db, 'generate_draft', { companyId: `C${i}` }, { dedupeKey: `C${i}` });
    }

    const other = openDb(path.join(dir, 'test.db'));
    try {
      const seen = new Set<number>();
      for (;;) {
        const a = claim(db);
        const b = claim(other);
        for (const t of [a, b]) {
          if (!t) continue;
          assert.ok(!seen.has(t.id), `task ${t.id} was claimed twice`);
          seen.add(t.id);
        }
        if (!a && !b) break;
      }
      assert.equal(seen.size, 20, 'every task claimed exactly once');
    } finally {
      other.close();
    }
  });
});
