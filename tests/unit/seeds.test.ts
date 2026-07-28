/**
 * Seed-source pure logic: ATS token guessing, Bay Area detection, YC ICP
 * filtering, and contact extraction from Hacker News comment text.
 *
 * These four functions decide which companies enter the pipeline at all. A
 * regression here does not throw — it just quietly shrinks or poisons the
 * funnel, which is why the tricky cases are pinned explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateTokens,
  extractEmails,
  extractUrls,
  filterYcIcp,
  isBayArea,
  type YcCompany,
} from '../../src/main/sources/seeds.js';

// ─────────────────────────────────────────────────────────────────────────────
// candidateTokens
// ─────────────────────────────────────────────────────────────────────────────

test('candidateTokens emits squashed, hyphenated, suffix-stripped and domain forms, most likely first', () => {
  // Measured examples from VERIFIED-SOURCES.md: People.ai resolves on "people-ai".
  assert.deepEqual(candidateTokens('People AI', 'https://www.people.ai'), [
    'peopleai',
    'people-ai',
    'people',
  ]);
  assert.deepEqual(candidateTokens('Foo Labs', null), ['foolabs', 'foo-labs', 'foo']);
  assert.deepEqual(candidateTokens('Acme Technologies', null), [
    'acmetechnologies',
    'acme-technologies',
    'acme',
  ]);
});

test('candidateTokens dedupes without reordering', () => {
  // Single-word names collapse to one token; the domain form is already present.
  assert.deepEqual(candidateTokens('Sunflower', 'https://sunflower.com'), ['sunflower']);
  assert.deepEqual(candidateTokens('Paradigm', null), ['paradigm']);
});

test('candidateTokens strips punctuation and collapses whitespace', () => {
  assert.deepEqual(candidateTokens('Sunflower & Co.', null), ['sunflowerco', 'sunflower-co']);
  assert.deepEqual(candidateTokens('  Acme   Robotics  ', null), ['acmerobotics', 'acme-robotics']);
  assert.deepEqual(candidateTokens('Réseau', null), ['rseau']);
});

test('candidateTokens only strips a suffix at the end of the name', () => {
  // "AI Systems Inc" -> the trailing "inc" goes, the leading "ai" stays.
  assert.deepEqual(candidateTokens('AI Systems Inc', null), ['aisystemsinc', 'ai-systems-inc', 'aisystems']);
  assert.deepEqual(candidateTokens('Labs Of Anything', null), ['labsofanything', 'labs-of-anything']);
});

test('candidateTokens drops tokens that are too short or too long to be ATS slugs', () => {
  assert.deepEqual(candidateTokens('X', null), []);
  assert.deepEqual(candidateTokens('!!!', null), []);
  const long = 'a'.repeat(80);
  assert.deepEqual(candidateTokens(long, null), []);
});

test('candidateTokens ignores a website without a protocol', () => {
  assert.deepEqual(candidateTokens('Acme', 'acme.com'), ['acme']);
  assert.deepEqual(candidateTokens('Acme Robotics', 'www.acmerobotics.io'), [
    'acmerobotics',
    'acme-robotics',
  ]);
});

test('candidateTokens takes the domain label from the website, lowercased', () => {
  assert.deepEqual(candidateTokens('Acme Robotics', 'https://ACME.io/careers'), [
    'acmerobotics',
    'acme-robotics',
    'acme',
  ]);
  assert.deepEqual(candidateTokens('Acme Robotics', 'http://www.acme-hq.com'), [
    'acmerobotics',
    'acme-robotics',
    'acme-hq',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// isBayArea
// ─────────────────────────────────────────────────────────────────────────────

test('isBayArea recognises the obvious cases, case-insensitively', () => {
  for (const loc of [
    'San Francisco, CA',
    'SAN FRANCISCO',
    'SF Bay Area',
    'Bay Area',
    'Oakland, CA',
    'Palo Alto',
    'Mountain View, California',
    'South San Francisco, CA',
    'Menlo Park, CA; New York, NY',
    'Remote — San Jose, CA',
    'Berkeley',
    'Emeryville, CA',
  ]) {
    assert.equal(isBayArea(loc), true, `${loc} should be Bay Area`);
  }
});

test('isBayArea rejects non-Bay locations', () => {
  for (const loc of [
    'New York, NY',
    'Austin, TX',
    'London, UK',
    'Remote (US)',
    'Seattle, WA',
    'Boston, MA',
    'San Antonio, TX',
    'Santa Monica, CA',
  ]) {
    assert.equal(isBayArea(loc), false, `${loc} should not be Bay Area`);
  }
});

test('isBayArea distinguishes Richmond CA from Richmond VA', () => {
  // The marker is deliberately "richmond, ca" and not "richmond" — Richmond VA
  // is a far bigger city and would flood the pipeline with out-of-region leads.
  assert.equal(isBayArea('Richmond, CA'), true);
  assert.equal(isBayArea('richmond, ca'), true);
  assert.equal(isBayArea('Richmond, VA'), false);
  assert.equal(isBayArea('Richmond, Virginia'), false);
  assert.equal(isBayArea('Richmond'), false);
});

test('isBayArea treats missing input as not Bay Area', () => {
  assert.equal(isBayArea(null), false);
  assert.equal(isBayArea(undefined), false);
  assert.equal(isBayArea(''), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// filterYcIcp
// ─────────────────────────────────────────────────────────────────────────────

function yc(over: Partial<YcCompany> = {}): YcCompany {
  return {
    id: 1,
    name: 'Acme',
    website: 'https://acme.com',
    all_locations: 'San Francisco, CA, USA',
    team_size: 40,
    batch: 'W24',
    industry: 'B2B',
    industries: ['B2B'],
    subindustry: 'B2B -> Engineering',
    one_liner: 'Acme does things',
    long_description: null,
    status: 'Active',
    isHiring: true,
    tags: [],
    ...over,
  };
}

const names = (rows: YcCompany[]) => rows.map((r) => r.name);

test('filterYcIcp keeps only Active companies', () => {
  const rows = [
    yc({ name: 'live', status: 'Active' }),
    yc({ name: 'dead', status: 'Inactive' }),
    yc({ name: 'bought', status: 'Acquired' }),
    yc({ name: 'unknown', status: null }),
  ];
  assert.deepEqual(names(filterYcIcp(rows)), ['live']);
});

test('filterYcIcp keeps only Bay Area companies', () => {
  const rows = [
    yc({ name: 'sf', all_locations: 'San Francisco, CA, USA' }),
    yc({ name: 'nyc', all_locations: 'New York, NY, USA' }),
    yc({ name: 'nowhere', all_locations: null }),
  ];
  assert.deepEqual(names(filterYcIcp(rows)), ['sf']);
});

test('filterYcIcp bands on team_size inclusively and lets unknown sizes through', () => {
  const rows = [
    yc({ name: 'tiny', team_size: 2 }),
    yc({ name: 'floor', team_size: 3 }),
    yc({ name: 'mid', team_size: 250 }),
    yc({ name: 'ceiling', team_size: 1000 }),
    yc({ name: 'huge', team_size: 1001 }),
    yc({ name: 'unknown', team_size: null }),
  ];
  assert.deepEqual(names(filterYcIcp(rows)), ['floor', 'mid', 'ceiling', 'unknown']);

  assert.deepEqual(
    names(filterYcIcp(rows, { minTeam: 10, maxTeam: 300 })),
    ['mid', 'unknown'],
  );
  // A zero-size row is still a real row; only the band decides.
  assert.deepEqual(names(filterYcIcp([yc({ name: 'zero', team_size: 0 })], { minTeam: 0 })), ['zero']);
});

test('filterYcIcp applies the hiring flag only when asked', () => {
  const rows = [
    yc({ name: 'hiring', isHiring: true }),
    yc({ name: 'not-hiring', isHiring: false }),
    yc({ name: 'unknown', isHiring: null }),
  ];
  assert.deepEqual(names(filterYcIcp(rows)), ['hiring', 'not-hiring', 'unknown']);
  assert.deepEqual(names(filterYcIcp(rows, { requireHiring: true })), ['hiring']);
});

test('filterYcIcp combines every predicate and returns a new array', () => {
  const rows = [
    yc({ name: 'perfect' }),
    yc({ name: 'wrong-city', all_locations: 'Austin, TX, USA' }),
    yc({ name: 'inactive', status: 'Inactive' }),
    yc({ name: 'too-big', team_size: 5000 }),
    yc({ name: 'idle', isHiring: false }),
  ];
  const out = filterYcIcp(rows, { requireHiring: true });
  assert.deepEqual(names(out), ['perfect']);
  assert.equal(rows.length, 5, 'the input list must not be mutated');
  assert.notEqual(out, rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractEmails — the cleanest-provenance contacts in the pipeline
// ─────────────────────────────────────────────────────────────────────────────

test('extractEmails pulls self-published addresses out of HN comment text', () => {
  const text = [
    'Acme | Senior Backend Engineer | SF or Remote | Full-time',
    'Email jane.doe@acme.com with a short note. Backup: hiring+eng@acme.com',
  ].join('\n');
  assert.deepEqual(extractEmails(text), ['jane.doe@acme.com', 'hiring+eng@acme.com']);
});

test('extractEmails survives HTML-entity soup without swallowing the address', () => {
  // HN serves "/" as &#x2F; — an address followed by an entity must not absorb it.
  const text = 'Apply: careers@acme.com&#x2F;jobs or bob@acme.com&#x27;s inbox';
  assert.deepEqual(extractEmails(text), ['careers@acme.com', 'bob@acme.com']);

  const withEntities = 'Contact &quot;Jane&quot; &lt;jane@acme.com&gt; today';
  assert.deepEqual(extractEmails(withEntities), ['jane@acme.com']);
});

test('extractEmails strips trailing sentence punctuation', () => {
  assert.deepEqual(extractEmails('Reach me at jane@acme.com.'), ['jane@acme.com']);
  assert.deepEqual(extractEmails('(bob@acme.io)'), ['bob@acme.io']);
  assert.deepEqual(extractEmails('mail: a@b.co, c@d.co; e@f.co'), ['a@b.co', 'c@d.co', 'e@f.co']);
  assert.deepEqual(extractEmails('[sam@acme.dev]'), ['sam@acme.dev']);
});

test('extractEmails rejects retina image filenames that look like addresses', () => {
  const text = 'logo@2x.png and hero@3x.jpg are assets, but jane@acme.com is a person';
  assert.deepEqual(extractEmails(text), ['jane@acme.com']);
});

test('extractEmails lowercases and dedupes', () => {
  const text = 'Jane@Acme.com or jane@acme.com or JANE@ACME.COM';
  assert.deepEqual(extractEmails(text), ['jane@acme.com']);
});

test('extractEmails returns an empty list when there is nothing to find', () => {
  assert.deepEqual(extractEmails(''), []);
  assert.deepEqual(extractEmails('No contact details in this post, apply via the site.'), []);
  assert.deepEqual(extractEmails('twitter @acme handle'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractUrls — shares the trailing-punctuation trimming
// ─────────────────────────────────────────────────────────────────────────────

test('extractUrls trims trailing punctuation and dedupes', () => {
  const text = 'See https://acme.com/careers. Also (https://acme.com/jobs) and https://acme.com/careers again';
  assert.deepEqual(extractUrls(text), ['https://acme.com/careers', 'https://acme.com/jobs']);
});

test('extractUrls ignores bare domains and returns an empty list when there are none', () => {
  assert.deepEqual(extractUrls('visit acme.com'), []);
  assert.deepEqual(extractUrls(''), []);
});
