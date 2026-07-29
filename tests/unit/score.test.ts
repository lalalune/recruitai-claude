/**
 * Scoring engine.
 *
 * Everything the operator sees is sorted by this file's output, so the tests
 * here are about invariants that would corrupt the ranking silently: a
 * disqualifier that stops firing, a monotonicity break that makes a busier
 * company rank lower, or a fee estimate that swallows an out-of-range comp.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ICP,
  FEE_RATE,
  daysOpen,
  estimateReqFee,
  estimateTotalFee,
  isEngineering,
  looksLikeRecruitingAgency,
  scoreCompany,
  scoreContact,
  type IcpConfig,
} from '../../src/shared/score.js';
import type { Company, Contact, Requisition } from '../../src/shared/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-28T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const daysAgo = (n: number, from: Date = NOW) => new Date(from.getTime() - n * 86_400_000).toISOString();

function company(over: Partial<Company> = {}): Company {
  return {
    id: 'co_1',
    domain: 'acme.test',
    name: 'Acme',
    nameNorm: 'acme',
    headcount: 40,
    headcountSource: 'yc',
    industry: 'Developer Tools',
    hqLocation: 'San Francisco, CA',
    inBayArea: true,
    fundingStage: 'Series A',
    lastRoundAt: null,
    atsPlatform: 'ashby',
    atsToken: 'acme',
    careersUrl: null,
    linkedinUrl: null,
    ycBatch: null,
    openReqCount: 0,
    openReqEngCount: 0,
    maxDaysOpen: null,
    staleReqCount: 0,
    recruiterCount: null,
    hasInhouseTa: null,
    noAgencyPolicy: false,
    qualityScore: null,
    scoreBreakdown: null,
    status: 'scored',
    reviewed: false,
    reviewedAt: null,
    notes: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

let reqSeq = 0;
function req(over: Partial<Requisition> = {}): Requisition {
  reqSeq++;
  return {
    id: `req_${reqSeq}`,
    companyId: 'co_1',
    externalId: `ext_${reqSeq}`,
    source: 'ashby',
    title: 'Senior Backend Engineer',
    department: 'Engineering',
    team: null,
    location: 'San Francisco, CA',
    isRemote: false,
    employmentType: 'FullTime',
    compMin: null,
    compMax: null,
    descriptionText: null,
    url: `https://jobs.ashbyhq.com/acme/${reqSeq}`,
    firstSeenAt: daysAgo(10),
    lastSeenAt: NOW_ISO,
    publishedAt: daysAgo(10),
    closedAt: null,
    daysOpen: null,
    repostCount: 0,
    functionFamily: null,
    seniority: null,
    noAgencyDisclaimer: null,
    namedContact: null,
    ...over,
  };
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: 'ct_1',
    companyId: 'co_1',
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    title: 'CTO',
    persona: 'cto_vpe',
    seniority: 'exec',
    email: 'jane@acme.test',
    emailSource: 'pattern_inference',
    emailVerdict: 'unverified',
    emailVerifiedAt: null,
    phone: null,
    linkedinUrl: null,
    isPrimary: false,
    contactScore: null,
    status: 'candidate',
    reviewed: false,
    notes: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

const score = (c: Company, reqs: Requisition[] = [req()], contacts: Contact[] = [], icp?: IcpConfig) =>
  scoreCompany({ company: c, reqs, contacts, now: NOW }, icp);

// ─────────────────────────────────────────────────────────────────────────────
// Disqualifiers — every one of these must keep firing
// ─────────────────────────────────────────────────────────────────────────────

test('disqualifier: suppressed company', () => {
  const r = score(company({ status: 'suppressed' }));
  assert.equal(r.disqualified, 'Suppressed');
  assert.equal(r.score, 0);
  assert.equal(r.raw, 0);
  assert.equal(r.estimatedFeeUsd, null);
  assert.deepEqual(r.components, []);
  assert.equal(r.headline, 'Suppressed');
});

test('disqualifier: company-level no-agency policy', () => {
  const r = score(company({ noAgencyPolicy: true }));
  assert.equal(r.disqualified, 'Job posting states no agency submissions');
  assert.equal(r.score, 0);
});

test('disqualifier: req-level no-agency disclaimer, even on one req among many', () => {
  const r = score(company(), [req(), req({ noAgencyDisclaimer: true }), req()]);
  assert.equal(r.disqualified, 'Job posting states no agency submissions');
});

test('a false/null no-agency disclaimer does not disqualify', () => {
  assert.equal(score(company(), [req({ noAgencyDisclaimer: false })]).disqualified, null);
  assert.equal(score(company(), [req({ noAgencyDisclaimer: null })]).disqualified, null);
});

test('disqualifier: outside the Bay Area, unless the ICP drops the requirement', () => {
  assert.equal(score(company({ inBayArea: false })).disqualified, 'Outside Bay Area');

  const relaxed: IcpConfig = { ...DEFAULT_ICP, requireBayArea: false };
  const r = score(company({ inBayArea: false }), [req()], [], relaxed);
  assert.equal(r.disqualified, null);
  assert.ok(r.score >= 1);
});

test('disqualifier: headcount below the ICP floor and above the ceiling', () => {
  assert.equal(score(company({ headcount: 2 })).disqualified, 'Too small (2 people)');
  assert.equal(score(company({ headcount: 1500 })).disqualified, 'Too large (1500 people)');

  // Boundaries are inclusive on both ends.
  assert.equal(score(company({ headcount: DEFAULT_ICP.minHeadcount })).disqualified, null);
  assert.equal(score(company({ headcount: DEFAULT_ICP.maxHeadcount })).disqualified, null);
  // Unknown headcount is not a rejection — most sources simply do not publish it.
  assert.equal(score(company({ headcount: null })).disqualified, null);
});

test('disqualifier: no open reqs (empty list, or every req closed)', () => {
  assert.equal(score(company(), []).disqualified, 'No open roles');
  assert.equal(score(company(), [req({ closedAt: daysAgo(1) })]).disqualified, 'No open roles');
  assert.equal(score(company(), [req({ closedAt: daysAgo(1) }), req()]).disqualified, null);
});

test('disqualifier: excluded keyword matches name or industry, case-insensitively', () => {
  const icp: IcpConfig = { ...DEFAULT_ICP, excludedKeywords: ['crypto', 'gambling'] };
  assert.equal(
    score(company({ industry: 'Crypto Exchange' }), [req()], [], icp).disqualified,
    'Excluded keyword: crypto',
  );
  assert.equal(
    score(company({ name: 'CryptoThing Inc' }), [req()], [], icp).disqualified,
    'Excluded keyword: crypto',
  );
  assert.equal(score(company(), [req()], [], icp).disqualified, null);
  // An empty keyword must never match everything.
  const sloppy: IcpConfig = { ...DEFAULT_ICP, excludedKeywords: ['', 'crypto'] };
  assert.equal(score(company(), [req()], [], sloppy).disqualified, null);
});

test('disqualifier: staffing/recruiting firms are never pitched', () => {
  for (const name of [
    'Bay Area Staffing Co',
    'Redwood Recruiting',
    'Apex Executive Search',
    'Talent Partners SF',
    'Peninsula Personnel',
    'Golden Gate Placement Group',
  ]) {
    assert.equal(
      score(company({ name })).disqualified,
      'Appears to be a staffing/recruiting firm',
      `${name} should be detected as an agency`,
    );
  }
  assert.equal(score(company({ name: 'Acme Robotics' })).disqualified, null);
});

test('looksLikeRecruitingAgency reads industry as well as name', () => {
  assert.equal(looksLikeRecruitingAgency('Acme', 'Staffing & Recruiting'), true);
  assert.equal(looksLikeRecruitingAgency('Acme', null), false);
  assert.equal(looksLikeRecruitingAgency('ACME HEADHUNTERS', null), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreCompany invariants
// ─────────────────────────────────────────────────────────────────────────────

test('more open reqs never lowers the score', () => {
  let prevRaw = -1;
  let prevScore = -1;
  for (let n = 1; n <= 15; n++) {
    const reqs = Array.from({ length: n }, () => req({ compMin: 150_000, compMax: 200_000 }));
    const r = score(company(), reqs);
    assert.equal(r.disqualified, null);
    assert.ok(r.raw >= prevRaw, `raw dropped from ${prevRaw} to ${r.raw} at n=${n}`);
    assert.ok(r.score >= prevScore, `score dropped from ${prevScore} to ${r.score} at n=${n}`);
    prevRaw = r.raw;
    prevScore = r.score;
  }
});

test('a stale req raises the score — it is the strongest pitch hook', () => {
  const fresh = score(company(), [req({ publishedAt: daysAgo(5), firstSeenAt: daysAgo(5) })]);
  const stale = score(company(), [req({ publishedAt: daysAgo(60), firstSeenAt: daysAgo(60) })]);
  const ancient = score(company(), [req({ publishedAt: daysAgo(200), firstSeenAt: daysAgo(200) })]);

  assert.ok(stale.raw > fresh.raw, `stale ${stale.raw} should beat fresh ${fresh.raw}`);
  assert.ok(ancient.raw > stale.raw, `very stale ${ancient.raw} should beat stale ${stale.raw}`);
  assert.match(stale.headline, /open >45d/);
  assert.match(stale.headline, /oldest 60d/);
});

test('a reposted req adds urgency signal', () => {
  const plain = score(company(), [req()]);
  const reposted = score(company(), [req({ repostCount: 2 })]);
  assert.ok(reposted.raw > plain.raw);
  const hiring = reposted.components.find((c) => c.key === 'hiring')!;
  assert.match(hiring.reason, /1 reposted/);
});

test('no in-house recruiter outscores an otherwise identical company with six', () => {
  const reqs = [req(), req()];
  const none = score(company({ recruiterCount: 0 }), reqs);
  const many = score(company({ recruiterCount: 6 }), reqs);

  assert.ok(none.raw > many.raw, `0 recruiters (${none.raw}) must beat 6 (${many.raw})`);
  assert.match(none.components.find((c) => c.key === 'fit')!.reason, /no in-house recruiter/);
  assert.match(many.components.find((c) => c.key === 'fit')!.reason, /likely handles own hiring/);

  // hasInhouseTa === false is an equally strong signal even when the count is unknown.
  const noTa = score(company({ recruiterCount: null, hasInhouseTa: false }), reqs);
  assert.equal(noTa.raw, none.raw);

  // Unknown sits strictly between the two.
  const unknown = score(company({ recruiterCount: null }), reqs);
  assert.ok(unknown.raw < none.raw && unknown.raw > many.raw);
});

test('the 20-75 headcount band is the sweet spot for agency fit', () => {
  const reqs = [req()];
  const fitOf = (headcount: number | null) =>
    score(company({ headcount, recruiterCount: 0 }), reqs).components.find((c) => c.key === 'fit')!.points;

  assert.ok(fitOf(40) > fitOf(150));
  assert.ok(fitOf(40) > fitOf(15));
  assert.ok(fitOf(40) > fitOf(5));
  assert.ok(fitOf(40) > fitOf(800));
  assert.equal(fitOf(20), fitOf(75), 'the band boundaries are inclusive');
});

test('recent funding lifts company quality, and the component is capped at its max', () => {
  const reqs = [req()];
  const qualityOf = (over: Partial<Company>) =>
    score(company(over), reqs).components.find((c) => c.key === 'quality')!;

  // lastRoundAt derives from the same frozen NOW the scorer is handed —
  // mixing in real Date.now() here made the deltas grow with the calendar
  // and the assertions would have started failing around mid-2028.
  const cold = qualityOf({ lastRoundAt: null, atsPlatform: null, fundingStage: null, ycBatch: null });
  const recent = qualityOf({ lastRoundAt: daysAgo(60) });
  const old = qualityOf({ lastRoundAt: daysAgo(900) });

  assert.ok(recent.points > old.points);
  assert.ok(old.points >= cold.points);
  assert.equal(cold.reason, 'No funding signal');

  const maxed = qualityOf({
    lastRoundAt: daysAgo(30),
    ycBatch: 'W25',
  });
  assert.ok(maxed.points <= maxed.max);
});

test('contactability rewards verified addresses and decision makers', () => {
  const reqs = [req()];
  const none = score(company(), reqs, []);
  const unverified = score(company(), reqs, [contact({ emailVerdict: 'unverified' })]);
  const catchAll = score(company(), reqs, [contact({ emailVerdict: 'catch_all' })]);
  const valid = score(company(), reqs, [contact({ emailVerdict: 'valid' })]);

  const pts = (r: ReturnType<typeof score>) => r.components.find((c) => c.key === 'contact')!.points;
  assert.equal(pts(none), 0);
  assert.equal(none.components.find((c) => c.key === 'contact')!.reason, 'No contacts found');
  assert.ok(pts(valid) > pts(catchAll));
  assert.ok(pts(catchAll) > 0);
  // An unverified decision maker still scores for being a decision maker.
  assert.ok(pts(unverified) > 0 && pts(unverified) < pts(valid));

  const nonDecisionMaker = score(company(), reqs, [
    contact({ persona: 'other', emailVerdict: 'unverified' }),
  ]);
  assert.equal(pts(nonDecisionMaker), 0);
});

test('every component stays inside its declared max and the raw total is 0-100', () => {
  const cases: { c: Company; reqs: Requisition[]; contacts: Contact[] }[] = [
    { c: company(), reqs: [req()], contacts: [] },
    {
      c: company({ headcount: 45, recruiterCount: 0, ycBatch: 'S25', lastRoundAt: NOW_ISO }),
      reqs: Array.from({ length: 30 }, () => req({ compMin: 400_000, compMax: 600_000, repostCount: 3, publishedAt: daysAgo(300), firstSeenAt: daysAgo(300) })),
      contacts: [contact({ emailVerdict: 'valid' }), contact({ persona: 'founder_ceo', emailVerdict: 'valid' })],
    },
    { c: company({ headcount: 900, recruiterCount: 20 }), reqs: [req()], contacts: [] },
  ];

  for (const { c, reqs, contacts } of cases) {
    const r = score(c, reqs, contacts);
    for (const comp of r.components) {
      assert.ok(comp.points >= 0, `${comp.key} went negative`);
      assert.ok(comp.points <= comp.max + 1e-9, `${comp.key} exceeded max ${comp.max}`);
    }
    assert.ok(r.raw >= 0 && r.raw <= 100, `raw ${r.raw} out of range`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// rawToTen (private — exercised through scoreCompany's raw/score pair)
// ─────────────────────────────────────────────────────────────────────────────

/** Independent re-derivation of the documented breakpoints. */
const RAW_TO_TEN_BREAKS = [12, 22, 31, 39, 47, 55, 63, 72, 82];
function expectedTen(rawExact: number): number {
  let n = 1;
  for (const b of RAW_TO_TEN_BREAKS) if (rawExact >= b) n++;
  return Math.min(10, n);
}

test('rawToTen produces 1..10 for the whole reachable score space, never 0 or 11', () => {
  const observed: { raw: number; score: number }[] = [];

  for (const headcount of [3, 12, 25, 60, 120, 400, 900]) {
    for (const recruiterCount of [0, 1, 3, 9, null]) {
      for (const nReqs of [1, 2, 5, 12, 30]) {
        for (const comp of [null, [90_000, 110_000], [300_000, 500_000]] as ([number, number] | null)[]) {
          for (const age of [3, 50, 150]) {
            const reqs = Array.from({ length: nReqs }, () =>
              req({
                compMin: comp?.[0] ?? null,
                compMax: comp?.[1] ?? null,
                publishedAt: daysAgo(age),
                firstSeenAt: daysAgo(age),
              }),
            );
            const r = score(
              company({ headcount, recruiterCount, ycBatch: nReqs % 2 ? 'W24' : null }),
              reqs,
              nReqs % 3 === 0 ? [contact({ emailVerdict: 'valid' })] : [],
            );

            assert.equal(r.disqualified, null);
            assert.ok(Number.isInteger(r.score), `score ${r.score} must be an integer`);
            assert.ok(r.score >= 1, `score ${r.score} fell below 1`);
            assert.ok(r.score <= 10, `score ${r.score} rose above 10`);

            const rawExact = Math.min(100, Math.max(0, r.components.reduce((s, c) => s + c.points, 0)));
            assert.equal(r.score, expectedTen(rawExact), `mapping mismatch at raw ${rawExact}`);
            assert.equal(r.raw, Math.round(rawExact));

            observed.push({ raw: rawExact, score: r.score });
          }
        }
      }
    }
  }

  // The mapping must be monotone: a higher raw can never map to a lower band.
  observed.sort((a, b) => a.raw - b.raw);
  for (let i = 1; i < observed.length; i++) {
    assert.ok(observed[i]!.score >= observed[i - 1]!.score, 'rawToTen must be monotone');
  }

  // The grid must actually straddle enough breakpoints for this to mean anything.
  const bands = new Set(observed.map((o) => o.score));
  assert.ok(bands.size >= 5, `expected a spread of bands, saw ${[...bands].sort().join(',')}`);
  assert.ok(Math.max(...observed.map((o) => o.raw)) >= 82, 'grid should reach the top band');
});

test('a maximal company scores 10 and a marginal one still scores at least 1', () => {
  const best = score(
    company({ headcount: 45, recruiterCount: 0, ycBatch: 'S26', lastRoundAt: daysAgo(20) }),
    Array.from({ length: 25 }, () =>
      req({ compMin: 250_000, compMax: 350_000, repostCount: 2, publishedAt: daysAgo(200), firstSeenAt: daysAgo(200) }),
    ),
    [contact({ emailVerdict: 'valid', persona: 'founder_ceo' })],
  );
  assert.equal(best.score, 10);

  const worst = score(company({ headcount: 5, recruiterCount: 40 }), [req()]);
  assert.ok(worst.score >= 1 && worst.score < 10);
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreContact
// ─────────────────────────────────────────────────────────────────────────────

test('a first in-house Head of Talent at 20-75 people is treated as a blocker, not a buyer', () => {
  const withTa = company({ headcount: 50, hasInhouseTa: true });
  const withoutTa = company({ headcount: 50, hasInhouseTa: false });
  const hot = contact({ persona: 'head_of_talent', emailVerdict: 'valid' });
  const eng = contact({ persona: 'cto_vpe', emailVerdict: 'valid' });

  // The insight this encodes: agency spend competes with that person's own
  // headcount budget, so they rank below the technical buyer.
  assert.ok(
    scoreContact(hot, withTa) < scoreContact(eng, withTa),
    'with an in-house TA team, Head of Talent must rank below CTO/VPE',
  );

  // Removing the in-house TA team lifts the penalty — the same persona is worth
  // materially more when they are not defending a team.
  assert.ok(
    scoreContact(hot, withoutTa) > scoreContact(hot, withTa),
    'without an in-house TA team the Head of Talent penalty must be lifted',
  );

  // Above 75 people the Head of Talent genuinely owns the vendor list and
  // overtakes the technical buyer. This is the real crossover in the model.
  const big = company({ headcount: 120, hasInhouseTa: true });
  assert.ok(
    scoreContact(hot, big) > scoreContact(eng, big),
    'above 75 people the Head of Talent must outrank CTO/VPE',
  );
});

test('below 20 people the founder is the decision maker', () => {
  const tiny = company({ headcount: 12 });
  const founder = contact({ persona: 'founder_ceo', emailVerdict: 'valid' });
  const hot = contact({ persona: 'head_of_talent', emailVerdict: 'valid' });
  const eng = contact({ persona: 'cto_vpe', emailVerdict: 'valid' });

  assert.ok(scoreContact(founder, tiny) > scoreContact(eng, tiny));
  assert.ok(scoreContact(founder, tiny) > scoreContact(hot, tiny));
});

test('founder weight decays as the company grows', () => {
  const founder = contact({ persona: 'founder_ceo', emailVerdict: 'valid' });
  const small = scoreContact(founder, company({ headcount: 40 }));
  const mid = scoreContact(founder, company({ headcount: 200 }));
  const large = scoreContact(founder, company({ headcount: 800 }));
  assert.ok(small > mid && mid > large);
});

test('verdict multipliers rank valid > catch_all > unknown > unverified > invalid', () => {
  const c = company({ headcount: 40 });
  const at = (emailVerdict: Contact['emailVerdict']) =>
    scoreContact(contact({ persona: 'founder_ceo', emailVerdict }), c);

  const valid = at('valid');
  const catchAll = at('catch_all');
  const unknown = at('unknown');
  const unverified = at('unverified');
  const invalid = at('invalid');

  assert.ok(valid > catchAll, `valid ${valid} > catch_all ${catchAll}`);
  assert.ok(catchAll > unknown, `catch_all ${catchAll} > unknown ${unknown}`);
  assert.ok(unknown > unverified, `unknown ${unknown} > unverified ${unverified}`);
  assert.ok(unverified > invalid, `unverified ${unverified} > invalid ${invalid}`);
  assert.ok(invalid > 0, 'even an invalid address keeps a non-zero ordering key');

  // Holding the multiplier constant, persona ordering must survive.
  const founder = at('catch_all');
  const other = scoreContact(contact({ persona: 'other', emailVerdict: 'catch_all' }), c);
  assert.ok(founder > other);
});

test('an unreachable perfect persona ranks below a reachable good one', () => {
  const c = company({ headcount: 40 });
  const unreachableFounder = scoreContact(contact({ persona: 'founder_ceo', emailVerdict: 'invalid' }), c);
  const reachableManager = scoreContact(contact({ persona: 'hiring_manager', emailVerdict: 'valid' }), c);
  assert.ok(reachableManager > unreachableFounder);
});

test('scoreContact returns a non-negative integer for every persona', () => {
  const personas: Contact['persona'][] = [
    'founder_ceo', 'cto_vpe', 'head_of_talent', 'recruiter', 'hiring_manager', 'coo_ops', 'other', null,
  ];
  for (const persona of personas) {
    for (const headcount of [null, 5, 20, 75, 76, 300, 2000]) {
      const s = scoreContact(contact({ persona, emailVerdict: 'valid' }), company({ headcount }));
      assert.ok(Number.isInteger(s) && s >= 0, `persona ${persona} at ${headcount} gave ${s}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fee estimation
// ─────────────────────────────────────────────────────────────────────────────

test('estimateReqFee is 30% of the comp midpoint', () => {
  assert.equal(FEE_RATE, 0.3);
  assert.equal(estimateReqFee(req({ compMin: 100_000, compMax: 200_000 })), 45_000);
  assert.equal(estimateReqFee(req({ compMin: 180_000, compMax: 180_000 })), 54_000);
});

test('estimateReqFee falls back to whichever bound exists', () => {
  assert.equal(estimateReqFee(req({ compMin: 200_000, compMax: null })), 60_000);
  assert.equal(estimateReqFee(req({ compMin: null, compMax: 200_000 })), 60_000);
});

test('estimateReqFee returns null rather than guessing on missing or out-of-range comp', () => {
  assert.equal(estimateReqFee(req({ compMin: null, compMax: null })), null);
  // An hourly rate that leaked through as an annual figure.
  assert.equal(estimateReqFee(req({ compMin: 60, compMax: 90 })), null);
  assert.equal(estimateReqFee(req({ compMin: 10_000, compMax: 19_000 })), null);
  // A total-package or multi-year figure.
  assert.equal(estimateReqFee(req({ compMin: 2_500_000, compMax: 4_000_000 })), null);
  // Boundaries are inclusive.
  assert.equal(estimateReqFee(req({ compMin: 20_000, compMax: 20_000 })), 6_000);
  assert.equal(estimateReqFee(req({ compMin: 2_000_000, compMax: 2_000_000 })), 600_000);
});

test('estimateTotalFee sums only the top 3 reqs by value', () => {
  const reqs = [
    req({ compMin: 100_000, compMax: 100_000 }), // 30k
    req({ compMin: 200_000, compMax: 200_000 }), // 60k
    req({ compMin: 300_000, compMax: 300_000 }), // 90k
    req({ compMin: 400_000, compMax: 400_000 }), // 120k
    req({ compMin: 500_000, compMax: 500_000 }), // 150k
  ];
  assert.equal(estimateTotalFee(reqs), 150_000 + 120_000 + 90_000);
});

test('estimateTotalFee ignores reqs with unusable comp, and is null when none are usable', () => {
  assert.equal(estimateTotalFee([]), null);
  assert.equal(estimateTotalFee([req(), req()]), null);
  assert.equal(estimateTotalFee([req({ compMin: 50, compMax: 75 })]), null);
  assert.equal(
    estimateTotalFee([req(), req({ compMin: 200_000, compMax: 200_000 }), req({ compMin: 10, compMax: 20 })]),
    60_000,
  );
});

test('estimateTotalFee does not mutate the caller’s array order', () => {
  const reqs = [
    req({ externalId: 'a', compMin: 100_000, compMax: 100_000 }),
    req({ externalId: 'b', compMin: 500_000, compMax: 500_000 }),
  ];
  const before = reqs.map((r) => r.externalId);
  estimateTotalFee(reqs);
  assert.deepEqual(reqs.map((r) => r.externalId), before);
});

test('scoreCompany reports the fee for open reqs only, and stays neutral when comp is unpublished', () => {
  const withComp = score(company(), [
    req({ compMin: 200_000, compMax: 200_000 }),
    req({ compMin: 900_000, compMax: 900_000, closedAt: daysAgo(1) }),
  ]);
  assert.equal(withComp.estimatedFeeUsd, 60_000);

  const noComp = score(company(), [req()]);
  assert.equal(noComp.estimatedFeeUsd, null);
  const fee = noComp.components.find((c) => c.key === 'fee')!;
  assert.equal(fee.points, 10);
  assert.match(fee.reason, /assumed median/);
});

// ─────────────────────────────────────────────────────────────────────────────
// daysOpen
// ─────────────────────────────────────────────────────────────────────────────

test('daysOpen prefers publishedAt over firstSeenAt', () => {
  assert.equal(daysOpen(req({ publishedAt: daysAgo(30), firstSeenAt: daysAgo(3) }), NOW), 30);
});

test('daysOpen falls back to firstSeenAt when publishedAt is absent', () => {
  assert.equal(daysOpen(req({ publishedAt: null, firstSeenAt: daysAgo(17) }), NOW), 17);
});

test('daysOpen measures to closedAt, not to now', () => {
  const r = req({ publishedAt: daysAgo(60), firstSeenAt: daysAgo(60), closedAt: daysAgo(50) });
  assert.equal(daysOpen(r, NOW), 10);
});

test('daysOpen is never negative', () => {
  const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
  assert.equal(daysOpen(req({ publishedAt: future, firstSeenAt: future }), NOW), 0);
  assert.equal(daysOpen(req({ publishedAt: daysAgo(10), closedAt: daysAgo(30) }), NOW), 0);
});

test('daysOpen returns 0 when there is no start date at all', () => {
  assert.equal(daysOpen(req({ publishedAt: null, firstSeenAt: '' as unknown as string }), NOW), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Headline & engineering classification
// ─────────────────────────────────────────────────────────────────────────────

test('the headline states role counts, staleness, TA status and fee', () => {
  const r = score(
    company({ recruiterCount: 0, fundingStage: 'Seed', lastRoundAt: daysAgo(90) }),
    [
      req({ title: 'Staff Backend Engineer', publishedAt: daysAgo(90), firstSeenAt: daysAgo(90), compMin: 200_000, compMax: 240_000 }),
      req({ title: 'Account Executive', department: 'Sales' }),
    ],
  );
  assert.match(r.headline, /^2 open roles \(1 eng\)/);
  assert.match(r.headline, /1 open >45d \(oldest 90d\)/);
  assert.match(r.headline, /no in-house recruiter/);
  assert.match(r.headline, /Seed 3mo ago/);
  assert.match(r.headline, /potential fee/);
});

test('isEngineering classifies by title and department', () => {
  for (const title of [
    'Senior Software Engineer', 'Backend Developer', 'ML Engineer', 'Site Reliability Engineer',
    'iOS Engineer', 'Data Scientist', 'Security Engineer', 'Platform Architect', 'Research Scientist',
  ]) {
    assert.equal(isEngineering(req({ title, department: null })), true, title);
  }
  for (const title of ['Account Executive', 'Office Coordinator', 'Chief of Staff', 'Recruiting Coordinator']) {
    assert.equal(isEngineering(req({ title, department: 'Sales' })), false, title);
  }
  assert.equal(isEngineering(req({ title: 'Manager', department: 'Engineering' })), true);
});
