/**
 * applyView — the Review list's filter/search/sort pipeline. Every branch the
 * operator can toggle is pinned here; two audits flagged it as the largest
 * untested pure surface in the renderer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyView, STALE_DAYS } from '../../src/renderer/lib/view.js';
import type { CompanyRow } from '../../src/shared/ipc.js';

let seq = 0;
function row(over: Partial<CompanyRow>): CompanyRow {
  seq += 1;
  return {
    id: `C${seq}`,
    name: `Company ${seq}`,
    domain: null,
    headcount: null,
    industry: null,
    hqLocation: null,
    inBayArea: true,
    fundingStage: null,
    ycBatch: null,
    atsPlatform: null,
    openReqCount: 0,
    openReqEngCount: 0,
    staleReqCount: 0,
    maxDaysOpen: null,
    recruiterCount: null,
    hasInhouseTa: null,
    estimatedFeeUsd: null,
    qualityScore: null,
    scoreHeadline: null,
    status: 'scored',
    reviewed: false,
    hasConflict: false,
    contactCount: 0,
    verifiedContactCount: 0,
    ...over,
  } as CompanyRow;
}

const T = { hasVerifiedEmail: false, noInhouseTa: false, staleOnly: false };

describe('applyView filters', () => {
  test('status filters map to row fields, not labels', () => {
    const rows = [
      row({ status: 'approved', reviewed: true }),
      row({ status: 'rejected', reviewed: true }),
      row({ status: 'scored', reviewed: false, hasConflict: true }),
    ];
    assert.equal(applyView(rows, 'approved', T, '', 'recent').length, 1);
    assert.equal(applyView(rows, 'rejected', T, '', 'recent').length, 1);
    assert.equal(applyView(rows, 'unreviewed', T, '', 'recent').length, 1);
    assert.equal(applyView(rows, 'conflicts', T, '', 'recent').length, 1);
    assert.equal(applyView(rows, 'all', T, '', 'recent').length, 3);
  });

  test('toggles: verified email, no in-house TA, stale-only', () => {
    const verified = row({ verifiedContactCount: 2 });
    const noTa = row({ hasInhouseTa: false });
    const zeroRecruiters = row({ hasInhouseTa: null, recruiterCount: 0 });
    const stale = row({ maxDaysOpen: STALE_DAYS });
    const rows = [verified, noTa, zeroRecruiters, stale, row({})];

    assert.deepEqual(applyView(rows, 'all', { ...T, hasVerifiedEmail: true }, '', 'recent').map((r) => r.id), [verified.id]);
    assert.deepEqual(
      applyView(rows, 'all', { ...T, noInhouseTa: true }, '', 'recent').map((r) => r.id).sort(),
      [noTa.id, zeroRecruiters.id].sort(),
    );
    assert.deepEqual(applyView(rows, 'all', { ...T, staleOnly: true }, '', 'recent').map((r) => r.id), [stale.id]);
  });

  test('search matches the local haystack OR the server id-set', () => {
    const local = row({ name: 'Quantum Widgets' });
    const serverOnly = row({ name: 'Opaque Name' });
    const neither = row({ name: 'Unrelated' });
    const rows = [local, serverOnly, neither];

    const got = applyView(rows, 'all', T, 'quantum', 'recent', new Set([serverOnly.id]));
    assert.deepEqual(got.map((r) => r.id).sort(), [local.id, serverOnly.id].sort());
    // No server set at all → local match only.
    assert.deepEqual(applyView(rows, 'all', T, 'quantum', 'recent', null).map((r) => r.id), [local.id]);
  });
});

describe('applyView sorting', () => {
  test('recent preserves server order; others tiebreak by score then name', () => {
    const a = row({ name: 'Alpha', openReqCount: 5, qualityScore: 3 });
    const b = row({ name: 'Beta', openReqCount: 5, qualityScore: 9 });
    const c = row({ name: 'Gamma', openReqCount: 1, qualityScore: 10 });
    const rows = [a, b, c];

    assert.deepEqual(applyView(rows, 'all', T, '', 'recent').map((r) => r.id), [a.id, b.id, c.id]);
    // reqs: a and b tie on 5 → score breaks it (b first); c trails on reqs.
    assert.deepEqual(applyView(rows, 'all', T, '', 'reqs').map((r) => r.id), [b.id, a.id, c.id]);
    assert.deepEqual(applyView(rows, 'all', T, '', 'name').map((r) => r.name), ['Alpha', 'Beta', 'Gamma']);
    // null scores sort last under score.
    const d = row({ name: 'Delta', qualityScore: null });
    assert.equal(applyView([d, c], 'all', T, '', 'score').at(-1)!.id, d.id);
  });
});
