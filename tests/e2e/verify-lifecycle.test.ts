/**
 * Verification lifecycle invariants.
 *
 * Two policies used to contradict each other: the freshness window queued
 * stale contacts for re-verification, while the idempotency ledger refused to
 * ever pay for the same address twice — so every re-verification collided and
 * FABRICATED an 'unknown' verdict over a perfectly good 'valid'. These tests
 * pin the reconciled behaviour: within the window the ledger collides (double
 * -charge protection), after it a fresh key is allocated (the re-check the
 * freshness policy promises), and the operator's force always pays.
 */

// Must come first: patches require('electron').
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, run, type Db } from '../../src/main/db/index.js';
import { __idempotencyKeyForTests as keyFor } from '../../src/main/verify/verifier.js';
import { decideContact } from '../../src/main/pipeline/contacts.js';

installElectronStub();

const FRESHNESS_MS = 183 * 86_400_000;

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-verify-life-'));
  initDb(path.join(tmpRoot, 'verify.db'));
});

after(() => {
  closeDb();
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows holds handles past close() long enough to defeat retries — a
       leaked CI tmpdir must not fail the suite (same stance as the stub). */
  }
});

function insertLedgerRow(db: Db, key: string, state: string, finishedAt: number | null): void {
  run(
    db,
    `INSERT INTO api_call (provider, endpoint, idempotency_key, state, est_cost_micros, finished_at)
     VALUES ('reoon', 'verify', ?, ?, 3000, ?)`,
    key,
    state,
    finishedAt,
  );
}

describe('idempotency key allocation vs the freshness window', () => {
  test('first verification uses the base key', () => {
    const db = getDb();
    assert.equal(keyFor(db, 'reoon', 'a@fresh-alloc.test', false, FRESHNESS_MS), 'a@fresh-alloc.test');
  });

  test('a RECENT success collides on the base key — no second charge inside the window', () => {
    const db = getDb();
    insertLedgerRow(db, 'b@recent.test', 'succeeded', Date.now() - 86_400_000);
    assert.equal(keyFor(db, 'reoon', 'b@recent.test', false, FRESHNESS_MS), 'b@recent.test');
  });

  test('a STALE success allocates a fresh key — re-verification is a real paid re-check', () => {
    const db = getDb();
    insertLedgerRow(db, 'c@stale.test', 'succeeded', Date.now() - FRESHNESS_MS - 86_400_000);
    assert.equal(keyFor(db, 'reoon', 'c@stale.test', false, FRESHNESS_MS), 'c@stale.test#2');
  });

  test('a stale FAILED row does not authorise a new key (reserve-reuse handles it)', () => {
    const db = getDb();
    insertLedgerRow(db, 'd@failed.test', 'failed', Date.now() - FRESHNESS_MS - 86_400_000);
    assert.equal(keyFor(db, 'reoon', 'd@failed.test', false, FRESHNESS_MS), 'd@failed.test');
  });

  test('force is a deliberate purchase and always allocates the next key', () => {
    const db = getDb();
    insertLedgerRow(db, 'e@forced.test', 'succeeded', Date.now());
    assert.equal(keyFor(db, 'reoon', 'e@forced.test', true, FRESHNESS_MS), 'e@forced.test#2');
    insertLedgerRow(db, 'e@forced.test#2', 'succeeded', Date.now());
    assert.equal(keyFor(db, 'reoon', 'e@forced.test', true, FRESHNESS_MS), 'e@forced.test#3');
  });

  test('a FAILED suffixed attempt retries under ITS OWN key — never the old succeeded base', () => {
    // The wedge: stale base success → #2 allocated → #2 fails once. Falling
    // back to the base key collided with the consumed base row and fabricated
    // 'unknown' forever. The failed row's own key is the retryable one.
    const db = getDb();
    insertLedgerRow(db, 'f@wedge.test', 'succeeded', Date.now() - FRESHNESS_MS - 86_400_000);
    assert.equal(keyFor(db, 'reoon', 'f@wedge.test', false, FRESHNESS_MS), 'f@wedge.test#2');
    insertLedgerRow(db, 'f@wedge.test#2', 'failed', Date.now());
    assert.equal(keyFor(db, 'reoon', 'f@wedge.test', false, FRESHNESS_MS), 'f@wedge.test#2');
    // A stuck reservation behaves the same: its own key, so the stale-
    // reservation message (not the already-charged one) reaches the operator.
    insertLedgerRow(db, 'g@wedge.test', 'succeeded', Date.now() - FRESHNESS_MS - 86_400_000);
    insertLedgerRow(db, 'g@wedge.test#2', 'reserved', null);
    assert.equal(keyFor(db, 'reoon', 'g@wedge.test', false, FRESHNESS_MS), 'g@wedge.test#2');
  });

  test('LIKE wildcards in local parts are escaped — john_smith never reads john.smith history', () => {
    const db = getDb();
    insertLedgerRow(db, 'john.smith@like.test', 'succeeded', Date.now() - FRESHNESS_MS - 86_400_000);
    insertLedgerRow(db, 'john.smith@like.test#2', 'succeeded', Date.now());
    // Never-verified underscore variant: base key, untouched by the dotted history.
    assert.equal(keyFor(db, 'reoon', 'john_smith@like.test', false, FRESHNESS_MS), 'john_smith@like.test');
  });
});

describe('decideContact honours MX-provider reliability', () => {
  const base = { catchAll: null, patternConformance: 1, sourceCount: 1 };

  test('valid on a high-reliability provider (Google) sends', () => {
    const d = decideContact({ ...base, verdict: 'valid', mxReliability: 'high' });
    assert.equal(d.decision, 'send');
  });

  test('valid on a LOW-reliability provider (Microsoft 365 / gateway) is review, never send', () => {
    const d = decideContact({ ...base, verdict: 'valid', mxReliability: 'low' });
    assert.equal(d.decision, 'review');
    assert.match(d.reason, /accepts almost anything/);
  });

  test('reliability does not resurrect a rejected verdict', () => {
    const d = decideContact({ ...base, verdict: 'invalid', mxReliability: 'high' });
    assert.equal(d.decision, 'reject');
  });

  test('a stored per-domain catch-all flag routes to review even when the result omitted it', () => {
    const d = decideContact({ ...base, verdict: 'valid', catchAll: true, mxReliability: 'high' });
    assert.equal(d.decision, 'review');
    assert.match(d.reason, /Catch-all/);
  });
});
