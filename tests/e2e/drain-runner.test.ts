/**
 * The drainer's dispatcher (src/main/pipeline/drain.ts).
 *
 * drain.test.ts proves the queue primitives; nothing there exercises the loop
 * that claims a task, routes it to a handler and records the outcome. The two
 * failure modes that matter are dispatch-level: a task kind with no handler
 * (a deploy-ordering bug — retrying can only repeat it, so it must be buried
 * immediately, not walked down the 5-attempt retry ladder), and a handler that
 * throws (which must be contained — one bad task can never stop the drain or
 * take the app down).
 */

// Must come first: patches require('electron') before any app module is evaluated.
import { installElectronStub } from './electron-stub.js';
installElectronStub();

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, get, run, ulid, type Db } from '../../src/main/db/index.js';
import { enqueue, claim } from '../../src/main/pipeline/tasks.js';
import { TASK_GENERATE_DRAFT, __drainOnceForTests } from '../../src/main/pipeline/drain.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';

let tmpRoot = '';
let db: Db;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-drain-runner-'));
  db = initDb(path.join(tmpRoot, 'drain-runner.db'));
});

after(() => {
  closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function reset(): void {
  run(db, 'DELETE FROM task');
}

/** The containment tests enqueue MISSING company ids: loadTarget throws a plain
 * Error ('Unknown company'), which — unlike the benign DraftNotPossible class —
 * must walk the retry ladder. */

interface TaskState {
  state: string;
  attempts: number;
  run_after: number;
  last_error: string | null;
}

function taskById(id: number): TaskState {
  const row = get<TaskState>(db, 'SELECT state, attempts, run_after, last_error FROM task WHERE id = ?', id);
  assert.ok(row, `task ${id} disappeared`);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('drain-runner', () => {
  test('a task with an unknown kind is buried immediately, not retried', async () => {
    reset();
    const id = enqueue(db, 'kind_from_the_future', { anything: true });
    assert.ok(id, 'enqueue must return an id');

    await __drainOnceForTests();

    const row = taskById(id);
    assert.equal(row.state, 'dead', 'an unknown kind is a bug, not a transient failure — dead-letter in one step');
    assert.equal(row.attempts, 1, 'buried on the first attempt; the retry ladder must not run');
    assert.match(row.last_error ?? '', /No handler registered/);
    assert.match(row.last_error ?? '', /kind_from_the_future/);
  });

  test('a handler that throws a REAL error is contained: the task backs off, the drain survives', async () => {
    reset();
    const enqueuedAt = Date.now();
    // An empty payload makes the handler itself throw a plain Error — the
    // transient/defect class that must walk the retry ladder. (A missing or
    // undraftable company is DraftNotPossible, which is a benign skip below.)
    const id = enqueue(db, TASK_GENERATE_DRAFT, {}, { dedupeKey: 'no-payload-1' });
    assert.ok(id);

    await __drainOnceForTests();

    const row = taskById(id);
    assert.equal(row.state, 'pending', 'a failed real handler goes back to pending, it is not lost');
    assert.equal(row.attempts, 1);
    assert.ok(row.run_after > enqueuedAt, `backoff must push run_after into the future (got ${row.run_after})`);
    assert.match(row.last_error ?? '', /no companyId/i, 'the handler error must be recorded on the task');
    assert.equal(claim(db), null, 'the task is not immediately re-claimable — backoff is real');
  });

  test('"cannot draft" is a business state, not a failure: the task completes as a skip', async () => {
    reset();
    // A missing (or merged-away, or already-emailed) company raises
    // DraftNotPossible — retrying can only repeat it, so the drainer records
    // the task done instead of grinding five retries into dead-letter noise.
    const id = enqueue(db, TASK_GENERATE_DRAFT, { companyId: 'co_gone_forever' }, { dedupeKey: 'co_gone_forever' });
    assert.ok(id);

    await __drainOnceForTests();

    assert.equal(taskById(id).state, 'done');
  });

  test('a repeatedly failing task dead-letters once max_attempts is exhausted', async () => {
    reset();
    const id = enqueue(db, TASK_GENERATE_DRAFT, {}, { dedupeKey: 'no-payload-2', maxAttempts: 1 });
    assert.ok(id);

    await __drainOnceForTests();

    const row = taskById(id);
    assert.equal(row.state, 'dead', 'attempts (1) >= max_attempts (1) must dead-letter, per fail() semantics');
    assert.match(row.last_error ?? '', /no companyId/i);
  });

  test('one poison task does not stop later tasks in the same drain pass', async () => {
    reset();
    const bad = enqueue(db, 'still_not_a_kind', {}, { priority: 1 });
    const real = enqueue(db, TASK_GENERATE_DRAFT, {}, { dedupeKey: 'no-payload-3', priority: 2 });
    assert.ok(bad);
    assert.ok(real);

    await __drainOnceForTests();

    // The unknown kind ran first (priority) and was buried; the real task was
    // still claimed and dispatched in the same pass.
    assert.equal(taskById(bad).state, 'dead');
    assert.equal(taskById(real).state, 'pending', 'the drain must keep going after burying a poison task');
    assert.equal(taskById(real).attempts, 1);
  });

  test('an empty queue drains to a no-op', async () => {
    reset();
    await __drainOnceForTests();
    assert.equal(get<{ n: number }>(getDb(), 'SELECT count(*) AS n FROM task')!.n, 0);
  });
});

describe('drain-runner happy path', () => {
  test('an approved company with an open req drains into a real draft row', async () => {
    reset();
    const db = getDb();
    const companyId = upsertCompany(db, { name: 'Drain Happy Co', domain: 'drain-happy.test' });
    run(db, `UPDATE company SET status = 'approved', headcount = 40, updated_at = ? WHERE id = ?`, Date.now(), companyId);
    run(
      db,
      `INSERT INTO req (company_id, external_id, source, title, url, first_seen_at, last_seen_at)
       VALUES (?, 'r1', 'greenhouse', 'Staff Engineer', 'https://x.test/j', ?, ?)`,
      companyId,
      Date.now() - 20 * 86_400_000,
      Date.now(),
    );
    const contactId = ulid();
    run(
      db,
      `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
       VALUES (?, ?, 'Ada L', 'Ada', 'ada@drain-happy.test', 'approved')`,
      contactId,
      companyId,
    );

    enqueue(db, TASK_GENERATE_DRAFT, { companyId }, { dedupeKey: companyId });
    await __drainOnceForTests();

    const draft = get<{ state: string; body: string }>(db, 'SELECT state, body FROM draft WHERE contact_id = ?', contactId);
    assert.ok(draft, 'the approve→draft pipeline produced a row');
    assert.equal(draft!.state, 'draft');
    assert.ok(draft!.body.startsWith('Hi Ada,'), 'the deterministic body rendered from real facts');
    assert.equal(get<{ state: string }>(db, `SELECT state FROM task WHERE dedupe_key = ?`, companyId)!.state, 'done');
  });
});
