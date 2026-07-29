/**
 * Renderer logic that runs headless: the event→query-key invalidation mapper,
 * the per-entity debouncer, shift+click anchor semantics in the UI store,
 * timestamp formatting, the Outreach tab enum fallback, and the canonical
 * verdict→tone mapping. No DOM, no React render — these are the pure seams the
 * screens are built on, so they are tested as plain functions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEntityDebouncer, invalidationKeysFor } from '../../src/renderer/lib/events.js';
import { ago, toMillis, verdictTone } from '../../src/renderer/lib/format.js';
import { normalizeOutreachTab, OUTREACH_TABS, useUi } from '../../src/renderer/store/ui.js';

// ─────────────────────────────────────────────────────────────────────────────
// invalidationKeysFor — fix 1's mapper
// ─────────────────────────────────────────────────────────────────────────────

const has = (keys: readonly (readonly string[])[], key: string[]) =>
  keys.some((k) => k.length === key.length && k.every((part, i) => part === key[i]));

test('company event without id refetches the list, search ids, details, stats and suppressions', () => {
  const keys = invalidationKeysFor('company', null);
  assert.ok(has(keys, ['companies', 'list']));
  // Pin: bulk/pipeline writes also stale the server-search id sets
  // (['companies','search',term]); the prefix invalidation refetches only
  // ACTIVE search queries, so the search results can't outlive the data.
  assert.ok(has(keys, ['companies', 'search']));
  assert.ok(has(keys, ['company']));
  assert.ok(has(keys, ['stats']));
  assert.ok(has(keys, ['suppressions']));
});

test('company event with ids targets those details and never the full list', () => {
  const keys = invalidationKeysFor('company', ['a', 'b']);
  assert.ok(has(keys, ['company', 'a']));
  assert.ok(has(keys, ['company', 'b']));
  assert.ok(has(keys, ['stats']));
  // The review hot path must not trigger a full-list refetch: id-carrying
  // company events are the renderer's own already-merged mutations. The same
  // goes for the server-search id sets.
  assert.ok(!has(keys, ['companies', 'list']));
  assert.ok(!has(keys, ['companies', 'search']));
});

test('contact events refresh the list columns as well as details — targeted or bulk', () => {
  // Pin: an id-carrying contact event must also refetch the companies list.
  // Contact edits change list columns (contactCount / verifiedContactCount /
  // qualityScore) and are operator-frequency, not hot-path.
  const targeted = invalidationKeysFor('contact', ['c1']);
  assert.ok(has(targeted, ['company']));
  assert.ok(has(targeted, ['companies', 'list']));
  assert.ok(has(targeted, ['stats']));

  const broad = invalidationKeysFor('contact', null);
  assert.ok(has(broad, ['companies', 'list']));
  assert.ok(has(broad, ['company']));
  assert.ok(has(broad, ['stats']));
});

test('draft events refresh drafts, stats, sendStats — and the Sent surfaces', () => {
  for (const ids of [null, ['d1']] as const) {
    const keys = invalidationKeysFor('draft', ids);
    assert.ok(has(keys, ['drafts']));
    assert.ok(has(keys, ['stats']));
    assert.ok(has(keys, ['sendStats']));
    // Every send emits a draft event; the Sent tab and its reply-rate strip
    // must not lag their own polls behind reality.
    assert.ok(has(keys, ['sent']));
    assert.ok(has(keys, ['performance']));
  }
  assert.ok(has(invalidationKeysFor('inbound'), ['sent']), 'outcome flips ride inbound events too');
});

test('inbound and suppression events map to their own queries', () => {
  assert.ok(has(invalidationKeysFor('inbound'), ['inbound']));
  const sup = invalidationKeysFor('suppression');
  assert.ok(has(sup, ['suppressions']));
  assert.ok(has(sup, ['companies', 'list']));
});

test('an unknown entity falls back to refreshing every db-derived query', () => {
  const keys = invalidationKeysFor('something-new');
  for (const expected of [
    ['companies', 'list'],
    ['company'],
    ['drafts'],
    ['inbound'],
    ['suppressions'],
    ['stats'],
    ['sendStats'],
  ]) {
    assert.ok(has(keys, expected), `missing ${expected.join('/')}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// createEntityDebouncer — burst coalescing
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('debouncer coalesces a burst into one flush per entity', async () => {
  const flushes: [string, string[] | null][] = [];
  const d = createEntityDebouncer((entity, ids) => flushes.push([entity, ids]), 30, 200);

  d.push('company', 'a');
  d.push('company', 'b');
  d.push('company', 'a'); // duplicate id collapses
  d.push('draft');

  await sleep(80);
  assert.equal(flushes.length, 2);
  const company = flushes.find(([e]) => e === 'company');
  const draft = flushes.find(([e]) => e === 'draft');
  assert.deepEqual(company?.[1]?.sort(), ['a', 'b']);
  assert.equal(draft?.[1], null); // id-less event → broad flush
  d.dispose();
});

test('one id-less event makes the whole window broad', async () => {
  const flushes: [string, string[] | null][] = [];
  const d = createEntityDebouncer((entity, ids) => flushes.push([entity, ids]), 30, 200);
  d.push('company', 'a');
  d.push('company'); // pipeline-style broad event
  await sleep(80);
  assert.deepEqual(flushes, [['company', null]]);
  d.dispose();
});

test('maxWait flushes even while events keep streaming', async () => {
  const flushes: string[] = [];
  const d = createEntityDebouncer((entity) => flushes.push(entity), 40, 120);
  const started = Date.now();
  // Push faster than the trailing debounce for ~300ms: a pure trailing
  // debounce would never fire in that window; maxWait must force it.
  while (Date.now() - started < 300) {
    d.push('company');
    await sleep(15);
  }
  assert.ok(flushes.length >= 1, 'maxWait never fired during a steady stream');
  d.dispose();
});

test('dispose drops pending work without flushing', async () => {
  const flushes: string[] = [];
  const d = createEntityDebouncer((entity) => flushes.push(entity), 20, 100);
  d.push('draft');
  d.dispose();
  await sleep(60);
  assert.deepEqual(flushes, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Anchor / range semantics — fix 5
// ─────────────────────────────────────────────────────────────────────────────

function resetSelection() {
  useUi.setState({ marked: [], anchorIndex: null, focusedIndex: 0 });
}

test('a plain click plants the anchor on the clicked row', () => {
  resetSelection();
  // Review's plain-click path: clearMarked() then focusAt(i), which calls
  // setAnchorIndex(i) alongside setFocusedIndex(i).
  useUi.getState().clearMarked();
  useUi.getState().setFocusedIndex(4);
  useUi.getState().setAnchorIndex(4);
  assert.equal(useUi.getState().anchorIndex, 4);
  assert.deepEqual(useUi.getState().marked, []);
});

test('shift+click ranges from the stored anchor without moving it', () => {
  resetSelection();
  useUi.getState().setAnchorIndex(2);
  // Rows 2..5 as Review computes them from the filtered slice.
  useUi.getState().markRange(['r2', 'r3', 'r4', 'r5']);
  assert.deepEqual([...useUi.getState().marked].sort(), ['r2', 'r3', 'r4', 'r5']);
  // The anchor survives the range so another shift+click re-aims from it.
  assert.equal(useUi.getState().anchorIndex, 2);

  // Second shift+click above the anchor: range merges, anchor still put.
  useUi.getState().markRange(['r0', 'r1', 'r2']);
  assert.deepEqual([...useUi.getState().marked].sort(), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.equal(useUi.getState().anchorIndex, 2);
});

test('moving the anchor re-aims the next range', () => {
  resetSelection();
  useUi.getState().setAnchorIndex(1);
  useUi.getState().markRange(['r1', 'r2']);
  // Plain click on row 7 (clear + focus + re-plant anchor)…
  useUi.getState().clearMarked();
  useUi.getState().setFocusedIndex(7);
  useUi.getState().setAnchorIndex(7);
  assert.deepEqual(useUi.getState().marked, []);
  // …then shift+click at 9 ranges 7..9, not from the old anchor.
  useUi.getState().markRange(['r7', 'r8', 'r9']);
  assert.deepEqual([...useUi.getState().marked].sort(), ['r7', 'r8', 'r9']);
  assert.equal(useUi.getState().anchorIndex, 7);
});

test('cmd+click toggles the row and moves the anchor there', () => {
  resetSelection();
  useUi.getState().toggleMarked('r5', 5);
  assert.deepEqual(useUi.getState().marked, ['r5']);
  assert.equal(useUi.getState().anchorIndex, 5);
  useUi.getState().toggleMarked('r5', 5);
  assert.deepEqual(useUi.getState().marked, []);
});

test('clearMarked clears the selection and the anchor', () => {
  resetSelection();
  useUi.getState().setAnchorIndex(3);
  useUi.getState().markRange(['r3', 'r4']);
  useUi.getState().clearMarked();
  assert.deepEqual(useUi.getState().marked, []);
  assert.equal(useUi.getState().anchorIndex, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// format.ts — toMillis / ago / verdictTone
// ─────────────────────────────────────────────────────────────────────────────

test('toMillis tolerates ms, seconds, ISO strings and junk', () => {
  assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000);
  // Seconds-precision timestamps are promoted to ms.
  assert.equal(toMillis(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMillis('2024-01-02T03:04:05.000Z'), Date.parse('2024-01-02T03:04:05.000Z'));
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(undefined), null);
  assert.equal(toMillis(0), null);
  assert.equal(toMillis('not a date'), null);
  assert.equal(toMillis(Number.NaN), null);
});

test('ago buckets read correctly at every magnitude', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const s = 1000;
  assert.equal(ago(now - 10 * s, now), 'just now');
  assert.equal(ago(now - 5 * 60 * s, now), '5m ago');
  assert.equal(ago(now - 3 * 3600 * s, now), '3h ago');
  assert.equal(ago(now - 4 * 86_400 * s, now), '4d ago');
  assert.equal(ago(now - 65 * 86_400 * s, now), '2mo ago');
  assert.equal(ago(now - 800 * 86_400 * s, now), '2.2y ago');
  assert.equal(ago(null, now), '—');
  // Future timestamps read as "in …", never negative.
  assert.equal(ago(now + 90 * s, now), 'in 2m');
});

test('verdictTone canonical mapping', () => {
  assert.equal(verdictTone('valid'), 'green');
  assert.equal(verdictTone('catch_all'), 'amber');
  assert.equal(verdictTone('invalid'), 'red');
  assert.equal(verdictTone('disposable'), 'red');
  assert.equal(verdictTone('role'), 'blue');
  assert.equal(verdictTone('unknown'), 'default');
  assert.equal(verdictTone('unverified'), 'default');
  assert.equal(verdictTone(null), 'default');
  assert.equal(verdictTone(undefined), 'default');
});

// ─────────────────────────────────────────────────────────────────────────────
// Outreach tab fallback — fix 22
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeOutreachTab accepts every real tab and rejects everything else', () => {
  for (const tab of OUTREACH_TABS) assert.equal(normalizeOutreachTab(tab), tab);
  assert.equal(normalizeOutreachTab('sequences'), 'drafts'); // retired tab name
  assert.equal(normalizeOutreachTab(''), 'drafts');
  assert.equal(normalizeOutreachTab(null), 'drafts');
  assert.equal(normalizeOutreachTab(undefined), 'drafts');
});
