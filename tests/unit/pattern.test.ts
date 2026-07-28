/**
 * Email-pattern inference.
 *
 * Two things are under test here. First, the mechanics: does a handful of
 * observed addresses produce the right pattern, and does the candidate
 * generator put the best guess first. Second — and this is the one that
 * actually protects the operator's money — that every confidence number in
 * this module is computed from THIS database's samples, with no published
 * vendor accuracy figure baked into the logic anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ALL_PATTERNS,
  buildEmail,
  detectPatterns,
  generateCandidates,
  globalPatternOrder,
  inferPattern,
  loadPattern,
  measuredPatternAccuracy,
  normalizeLastName,
  normalizeNamePart,
  patternConformance,
  refreshPattern,
  renderPattern,
  savePattern,
  seedsFromDb,
  splitFullName,
  type EmailPattern,
  type KnownAddress,
} from '../../src/main/verify/pattern.js';
import { openDb, run, ulid, type Db } from '../../src/main/db/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Name normalisation
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeNamePart strips diacritics and everything not a letter', () => {
  assert.equal(normalizeNamePart('José'), 'jose');
  assert.equal(normalizeNamePart("O'Brien"), 'obrien');
  assert.equal(normalizeNamePart('Anne-Marie'), 'annemarie');
  assert.equal(normalizeNamePart('  Jane  '), 'jane');
  assert.equal(normalizeNamePart(null), '');
  assert.equal(normalizeNamePart('123'), '');
});

test('normalizeLastName joins particles rather than dropping them', () => {
  // "van der Berg" is written vanderberg in a local part far more often than berg.
  assert.equal(normalizeLastName('van der Berg'), 'vanderberg');
  assert.equal(normalizeLastName('de la Cruz'), 'delacruz');
  assert.equal(normalizeLastName('Smith-Jones'), 'smithjones');
  assert.equal(normalizeLastName('Müller'), 'muller');
  assert.equal(normalizeLastName(''), '');
});

test('splitFullName drops suffixes, parentheticals and middle names', () => {
  assert.deepEqual(splitFullName('Jane Doe'), { first: 'Jane', last: 'Doe' });
  assert.deepEqual(splitFullName('Jane Q. Doe'), { first: 'Jane', last: 'Doe' });
  assert.deepEqual(splitFullName('Jane Doe, PhD'), { first: 'Jane', last: 'Doe' });
  assert.deepEqual(splitFullName('Robert Smith Jr.'), { first: 'Robert', last: 'Smith' });
  assert.deepEqual(splitFullName('Kai (Kaitlyn) Chen'), { first: 'Kai', last: 'Chen' });
  assert.deepEqual(splitFullName('Jan van der Berg'), { first: 'Jan', last: 'van der Berg' });
  assert.deepEqual(splitFullName('Cher'), { first: 'Cher', last: '' });
  assert.deepEqual(splitFullName('   '), { first: '', last: '' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering / detection
// ─────────────────────────────────────────────────────────────────────────────

test('renderPattern produces the documented local part for every pattern', () => {
  const expected: Record<EmailPattern, string> = {
    'first.last': 'jane.doe',
    firstlast: 'janedoe',
    flast: 'jdoe',
    first_last: 'jane_doe',
    first: 'jane',
    'f.last': 'j.doe',
    lastf: 'doej',
    'first-last': 'jane-doe',
    firstl: 'janed',
  };
  for (const p of ALL_PATTERNS) {
    assert.equal(renderPattern(p, 'Jane', 'Doe'), expected[p], p);
  }
  assert.equal(new Set(ALL_PATTERNS).size, ALL_PATTERNS.length, 'ALL_PATTERNS must not repeat');
});

test('renderPattern refuses to render what the names cannot fill', () => {
  assert.equal(renderPattern('first.last', 'Jane', ''), '');
  assert.equal(renderPattern('first', 'Jane', ''), 'jane');
  assert.equal(renderPattern('flast', '', 'Doe'), '');
  assert.equal(buildEmail('first.last', 'Jane', '', 'acme.com'), '');
  assert.equal(buildEmail('first.last', 'Jane', 'Doe', 'ACME.COM'), 'jane.doe@acme.com');
});

test('detectPatterns returns every pattern that could have produced the address', () => {
  assert.deepEqual(detectPatterns('jane.doe@acme.com', 'Jane', 'Doe'), ['first.last']);
  assert.deepEqual(detectPatterns('jdoe@acme.com', 'Jane', 'Doe'), ['flast']);
  // A single-letter first name makes firstlast and flast indistinguishable.
  assert.deepEqual(detectPatterns('jdoe@acme.com', 'J', 'Doe'), ['firstlast', 'flast']);
  assert.deepEqual(detectPatterns('jane@acme.com', 'Jane', 'Doe'), ['first']);
  assert.deepEqual(detectPatterns('janed@acme.com', 'Jane', 'Doe'), ['firstl']);
  assert.deepEqual(detectPatterns('doej@acme.com', 'Jane', 'Doe'), ['lastf']);
  // A nickname matches nothing — the module must not invent a pattern for it.
  assert.deepEqual(detectPatterns('jd.the.great@acme.com', 'Jane', 'Doe'), []);
  assert.deepEqual(detectPatterns('jane.doe@acme.com', null, 'Doe'), []);
});

test('detectPatterns ignores plus-addressing', () => {
  assert.deepEqual(detectPatterns('jane.doe+jobs@acme.com', 'Jane', 'Doe'), ['first.last']);
});

test('patternConformance grades an address against a known pattern', () => {
  assert.equal(patternConformance('jane.doe@acme.com', 'Jane', 'Doe', 'first.last', 0.8), 0.8);
  // Confidence floors at 0.6 for a conforming address.
  assert.equal(patternConformance('jane.doe@acme.com', 'Jane', 'Doe', 'first.last', 0.1), 0.6);
  assert.equal(patternConformance('jdoe@acme.com', 'Jane', 'Doe', 'first.last', 0.8), 0.2);
  assert.equal(patternConformance('jane.doe@acme.com', 'Jane', 'Doe', null), 0.5);
  assert.equal(patternConformance('nickname@acme.com', 'Jane', 'Doe', 'first.last', 0.9), 0.15);
  assert.equal(patternConformance('nickname@acme.com', null, null, 'first.last', 0.9), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// inferPattern
// ─────────────────────────────────────────────────────────────────────────────

const seed = (email: string, firstName: string | null, lastName: string | null): KnownAddress => ({
  email,
  firstName,
  lastName,
});

test('inferPattern agrees on a unanimous domain', () => {
  const out = inferPattern('acme.com', [
    seed('jane.doe@acme.com', 'Jane', 'Doe'),
    seed('bob.smith@acme.com', 'Bob', 'Smith'),
    seed('amy.chen@acme.com', 'Amy', 'Chen'),
  ]);
  assert.equal(out.pattern, 'first.last');
  assert.equal(out.sampleCount, 3);
  assert.equal(out.agreeing, 3);
  // Laplace-smoothed: agreeing / (samples + 1).
  assert.equal(out.confidence, 3 / 4);
  assert.deepEqual(out.ranked, [{ pattern: 'first.last', support: 3 }]);
});

/**
 * Distinct alphabetic names — digits are stripped by normalizeNamePart, so a
 * generator like `First${i}` would collide into a single sample.
 */
function person(i: number): { first: string; last: string } {
  const a = String.fromCharCode(97 + (i % 26));
  const b = String.fromCharCode(97 + Math.floor(i / 26));
  return { first: `na${b}${a}`, last: `sur${b}${a}` };
}

test('inferPattern confidence rises with sample count and never reads as certainty', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const { first, last } = person(i);
      return seed(`${first}.${last}@acme.com`, first, last);
    });

  const one = inferPattern('acme.com', make(1));
  const three = inferPattern('acme.com', make(3));
  const five = inferPattern('acme.com', make(5));
  const many = inferPattern('acme.com', make(40));

  assert.equal(one.confidence, 1 / 2, 'a single observation can never read as certainty');
  assert.equal(three.confidence, 3 / 4);
  assert.equal(five.confidence, 5 / 6);
  assert.ok(one.confidence < three.confidence);
  assert.ok(three.confidence < five.confidence);
  assert.ok(five.confidence < many.confidence);
  assert.equal(many.confidence, 0.95, 'confidence is capped short of 1');
  for (const r of [one, three, five, many]) assert.equal(r.pattern, 'first.last');
});

test('inferPattern lowers confidence when samples disagree', () => {
  const agreeing = inferPattern('acme.com', [
    seed('jane.doe@acme.com', 'Jane', 'Doe'),
    seed('bob.smith@acme.com', 'Bob', 'Smith'),
    seed('amy.chen@acme.com', 'Amy', 'Chen'),
  ]);
  const mixed = inferPattern('acme.com', [
    seed('jane.doe@acme.com', 'Jane', 'Doe'),
    seed('bob.smith@acme.com', 'Bob', 'Smith'),
    seed('amy.chen@acme.com', 'Amy', 'Chen'),
    seed('rchowdhury@acme.com', 'Raj', 'Chowdhury'),
  ]);

  assert.equal(mixed.pattern, 'first.last');
  assert.equal(mixed.sampleCount, 4);
  assert.equal(mixed.agreeing, 3);
  assert.equal(mixed.confidence, 3 / 5);
  assert.ok(mixed.confidence < agreeing.confidence, 'disagreement must cost confidence');
  assert.deepEqual(mixed.ranked, [
    { pattern: 'first.last', support: 3 },
    { pattern: 'flast', support: 1 },
  ]);
});

test('inferPattern counts a sample that matches nothing against confidence', () => {
  const out = inferPattern('acme.com', [
    seed('jane.doe@acme.com', 'Jane', 'Doe'),
    seed('bob.smith@acme.com', 'Bob', 'Smith'),
    seed('bigdog@acme.com', 'Raj', 'Chowdhury'),
  ]);
  assert.equal(out.pattern, 'first.last');
  assert.equal(out.sampleCount, 3, 'the nickname is still a sample');
  assert.equal(out.agreeing, 2);
  assert.equal(out.confidence, 2 / 4);
});

test('inferPattern shares support when an address is ambiguous', () => {
  const out = inferPattern('acme.com', [seed('jdoe@acme.com', 'J', 'Doe')]);
  // firstlast and flast are indistinguishable here, so neither gets full credit.
  assert.deepEqual(out.ranked, [
    { pattern: 'firstlast', support: 0.5 },
    { pattern: 'flast', support: 0.5 },
  ]);
  assert.equal(out.pattern, 'firstlast', 'ties break by the canonical pattern order');
  assert.equal(out.confidence, 0.25);
});

test('inferPattern ignores role accounts, other domains, duplicates and nameless rows', () => {
  const out = inferPattern('acme.com', [
    seed('jane.doe@acme.com', 'Jane', 'Doe'),
    seed('jane.doe@acme.com', 'Jane', 'Doe'), // duplicate
    seed('JANE.DOE@ACME.COM', 'Jane', 'Doe'), // same address, different case
    seed('careers@acme.com', 'Careers', 'Team'), // shared mailbox
    seed('bob.smith@other.com', 'Bob', 'Smith'), // different domain
    seed('nameless@acme.com', null, null), // nothing to infer from
  ]);
  assert.equal(out.sampleCount, 1);
  assert.equal(out.pattern, 'first.last');
  assert.equal(out.confidence, 0.5);
});

test('inferPattern returns nothing usable when there is nothing to learn from', () => {
  for (const seeds of [[], [seed('careers@acme.com', 'Careers', null)], [seed('x@other.com', 'X', 'Y')]]) {
    const out = inferPattern('acme.com', seeds);
    assert.equal(out.pattern, null);
    assert.equal(out.confidence, 0);
    assert.deepEqual(out.ranked, []);
    assert.equal(out.agreeing, 0);
  }
});

test('inferPattern is case-insensitive about the domain it is asked for', () => {
  const out = inferPattern('ACME.com', [seed('jane.doe@acme.com', 'Jane', 'Doe')]);
  assert.equal(out.pattern, 'first.last');
});

// ─────────────────────────────────────────────────────────────────────────────
// generateCandidates
// ─────────────────────────────────────────────────────────────────────────────

test('generateCandidates with no known pattern follows the fallback ordering', () => {
  const out = generateCandidates('Jane', 'Doe', 'acme.com', null);
  assert.deepEqual(out.map((c) => c.email), [
    'jane.doe@acme.com',
    'jane@acme.com',
    'jdoe@acme.com',
    'janedoe@acme.com',
    'j.doe@acme.com',
  ]);
  assert.deepEqual(out.map((c) => c.rank), [0, 1, 2, 3, 4]);
  assert.deepEqual(out.map((c) => c.pattern), ['first.last', 'first', 'flast', 'firstlast', 'f.last']);
  assert.ok(out.every((c) => !c.fromKnownPattern && c.confidence === 0));
  assert.equal(out[0]!.localPart, 'jane.doe');
});

test('generateCandidates puts a known pattern first and carries its confidence', () => {
  const out = generateCandidates('Jane', 'Doe', 'acme.com', 'flast', { confidence: 0.83 });

  assert.equal(out[0]!.email, 'jdoe@acme.com');
  assert.equal(out[0]!.pattern, 'flast');
  assert.equal(out[0]!.rank, 0);
  assert.equal(out[0]!.fromKnownPattern, true);
  assert.equal(out[0]!.confidence, 0.83);

  // Everything after it is a hedge, and carries no borrowed confidence.
  assert.deepEqual(out.slice(1).map((c) => c.email), [
    'jane.doe@acme.com',
    'jane@acme.com',
    'janedoe@acme.com',
    'j.doe@acme.com',
  ]);
  assert.ok(out.slice(1).every((c) => c.confidence === 0 && !c.fromKnownPattern));
  assert.equal(new Set(out.map((c) => c.pattern)).size, out.length, 'no pattern may repeat');
});

test('generateCandidates honours a caller-supplied ordering', () => {
  const order: EmailPattern[] = ['lastf', 'firstl', 'first.last'];
  const out = generateCandidates('Jane', 'Doe', 'acme.com', null, { order, limit: 3 });
  assert.deepEqual(out.map((c) => c.email), ['doej@acme.com', 'janed@acme.com', 'jane.doe@acme.com']);
});

test('generateCandidates dedupes addresses that several patterns collapse onto', () => {
  const out = generateCandidates('J', 'Doe', 'acme.com');
  const emails = out.map((c) => c.email);
  assert.equal(new Set(emails).size, emails.length, 'duplicate guesses would be paid for twice');
  assert.deepEqual(emails, [
    'j.doe@acme.com',
    'j@acme.com',
    'jdoe@acme.com',
    'j_doe@acme.com',
    'jd@acme.com',
  ]);
});

test('generateCandidates never guesses a shared mailbox', () => {
  // "Dev Patel" would otherwise produce dev.patel@ and dev@, both of which reach
  // an engineering alias rather than a person.
  const out = generateCandidates('Dev', 'Patel', 'acme.com');
  assert.ok(!out.some((c) => c.localPart === 'dev' || c.localPart === 'dev.patel'));
  assert.equal(out[0]!.email, 'dpatel@acme.com');

  assert.deepEqual(generateCandidates('Info', null, 'acme.com'), []);
});

test('generateCandidates falls back to first-name-only when there is no surname', () => {
  const out = generateCandidates('Jane', null, 'acme.com');
  assert.deepEqual(out.map((c) => c.email), ['jane@acme.com']);
  assert.equal(out[0]!.pattern, 'first');
});

test('generateCandidates normalises the domain and respects the limit', () => {
  assert.equal(generateCandidates('Jane', 'Doe', '@ACME.com')[0]!.email, 'jane.doe@acme.com');
  assert.equal(generateCandidates('Jane', 'Doe', 'acme.com', null, { limit: 2 }).length, 2);
  assert.equal(generateCandidates('Jane', 'Doe', 'acme.com', null, { limit: 0 }).length, 0);
  assert.deepEqual(generateCandidates(null, 'Doe', 'acme.com'), []);
  assert.deepEqual(generateCandidates('Jane', 'Doe', ''), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// No published accuracy constant is baked into the logic
// ─────────────────────────────────────────────────────────────────────────────

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'main', 'verify', 'pattern.ts'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate the repo root from ${process.cwd()}`);
}

/** Strips comments so prose about a number is not mistaken for using it. */
function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

test('pattern.ts contains no hardcoded published accuracy figure', () => {
  const src = fs.readFileSync(path.join(repoRoot(), 'src/main/verify/pattern.ts'), 'utf8');
  const code = codeWithoutComments(src);

  // The widely repeated "87% / 97% accurate" numbers are vendor marketing for a
  // paid database lookup and measure a different method entirely. They may be
  // discussed in the header comment; they must never reach executable code.
  for (const n of ['0.87', '0.97', '87', '97']) {
    assert.ok(
      !new RegExp(`(?<![\\w.])${n.replace('.', '\\.')}(?![\\w.])`).test(code),
      `pattern.ts must not hardcode ${n}`,
    );
  }
  // (Bare `%` is legitimate here — it is the SQL LIKE wildcard.)
  assert.ok(!/\d\s*%(?!\s*@)/.test(code), 'no percentage literals belong in the logic');

  // No constant that claims an accuracy/hit rate the operator cannot verify.
  const suspicious = code.match(/const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*0?\.\d+/g) ?? [];
  for (const decl of suspicious) {
    assert.ok(
      !/accuracy|accurate|precision|hit.?rate|deliverab/i.test(decl),
      `suspicious constant: ${decl}`,
    );
  }

  // The header must still carry the reasoning, or the next reader will "fix" it
  // by importing a brochure number.
  assert.match(src, /measuredPatternAccuracy/);
  assert.match(src, /no hardcoded accuracy constant/i);
});

test('confidence is a function of the samples, not a fixed number', () => {
  const seen = new Set<number>();
  for (let n = 1; n <= 6; n++) {
    const seeds = Array.from({ length: n }, (_, i) => {
      const { first, last } = person(i);
      return seed(`${first}.${last}@acme.com`, first, last);
    });
    const inferred = inferPattern('acme.com', seeds);
    assert.equal(inferred.pattern, 'first.last');
    seen.add(inferred.confidence);
  }
  assert.equal(seen.size, 6, 'every distinct sample count must produce a distinct confidence');
});

// ─────────────────────────────────────────────────────────────────────────────
// Database-backed: measured from the operator's own data
// ─────────────────────────────────────────────────────────────────────────────

function withDb(fn: (db: Db) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-pattern-'));
  const db = openDb(path.join(dir, 'test.db'));
  try {
    fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function insertCompany(db: Db, domain: string): string {
  const id = ulid();
  run(
    db,
    'INSERT INTO company (id, domain, name, name_norm) VALUES (?, ?, ?, ?)',
    id,
    domain,
    domain,
    domain,
  );
  return id;
}

function insertContact(
  db: Db,
  companyId: string,
  row: {
    first?: string | null;
    last?: string | null;
    email: string;
    verdict?: string;
    pattern?: string | null;
    verifiedAt?: number | null;
  },
): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO contact (id, company_id, first_name, last_name, full_name, email, email_verdict, email_pattern, email_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    companyId,
    row.first ?? null,
    row.last ?? null,
    `${row.first ?? ''} ${row.last ?? ''}`.trim() || 'unknown',
    row.email,
    row.verdict ?? 'unverified',
    row.pattern ?? null,
    row.verifiedAt ?? null,
  );
  return id;
}

test('measuredPatternAccuracy reports null until there is something to measure', () => {
  withDb((db) => {
    const out = measuredPatternAccuracy(db);
    assert.equal(out.rate, null, 'an unmeasured rate must be null, not a default figure');
    assert.equal(out.attempts, 0);
    assert.equal(out.valid, 0);
    assert.equal(out.invalid, 0);
  });
});

test('measuredPatternAccuracy computes the operator’s real hit rate', () => {
  withDb((db) => {
    const co = insertCompany(db, 'acme.com');
    const rows: [string, string][] = [
      ['a@acme.com', 'valid'],
      ['b@acme.com', 'valid'],
      ['c@acme.com', 'valid'],
      ['d@acme.com', 'invalid'],
      ['e@acme.com', 'catch_all'], // inconclusive: excluded from the denominator
    ];
    for (const [email, verdict] of rows) {
      insertContact(db, co, { first: 'X', last: 'Y', email, verdict, pattern: 'first.last', verifiedAt: 1 });
    }
    // Unverified guesses are not attempts yet.
    insertContact(db, co, { first: 'X', email: 'f@acme.com', pattern: 'first.last', verifiedAt: null });
    // Observed (non-pattern) addresses are not attempts at all.
    insertContact(db, co, { first: 'X', email: 'g@acme.com', verdict: 'valid', pattern: null, verifiedAt: 1 });

    const out = measuredPatternAccuracy(db);
    assert.equal(out.attempts, 5);
    assert.equal(out.valid, 3);
    assert.equal(out.invalid, 1);
    assert.equal(out.inconclusive, 1);
    assert.equal(out.rate, 3 / 4, 'rate is valid / decided, measured from this database');

    assert.equal(measuredPatternAccuracy(db, 'flast').rate, null, 'per-pattern rates are separate');
  });
});

test('globalPatternOrder is the fallback until the operator has data, then reorders by it', () => {
  withDb((db) => {
    const cold = globalPatternOrder(db);
    assert.deepEqual(cold.slice(0, 3), ['first.last', 'first', 'flast']);
    assert.equal(cold.length, ALL_PATTERNS.length);
    assert.equal(new Set(cold).size, cold.length);

    for (const domain of ['a.com', 'b.com', 'c.com']) {
      savePattern(db, domain, {
        pattern: 'flast',
        confidence: 0.8,
        sampleCount: 4,
        agreeing: 4,
        ranked: [],
      });
    }
    savePattern(db, 'd.com', {
      pattern: 'firstl',
      confidence: 0.5,
      sampleCount: 2,
      agreeing: 2,
      ranked: [],
    });

    const warm = globalPatternOrder(db);
    assert.equal(warm[0], 'flast', 'the operator’s own most-observed pattern leads');
    assert.equal(warm[1], 'firstl');
    assert.equal(warm.length, ALL_PATTERNS.length);
    assert.equal(new Set(warm).size, warm.length, 'no pattern may be listed twice');
  });
});

test('savePattern/loadPattern round-trips, and a null pattern is stored as empty', () => {
  withDb((db) => {
    assert.equal(loadPattern(db, 'acme.com'), null);

    savePattern(db, 'ACME.com', { pattern: 'f.last', confidence: 0.75, sampleCount: 3, agreeing: 3, ranked: [] });
    const stored = loadPattern(db, 'acme.com')!;
    assert.equal(stored.domain, 'acme.com');
    assert.equal(stored.pattern, 'f.last');
    assert.equal(stored.confidence, 0.75);
    assert.equal(stored.sampleCount, 3);
    assert.equal(stored.isCatchAll, null);
    assert.ok(stored.updatedAt > 0);

    savePattern(db, 'acme.com', { pattern: null, confidence: 0, sampleCount: 0, agreeing: 0, ranked: [] });
    const cleared = loadPattern(db, 'acme.com')!;
    assert.equal(cleared.pattern, null);
    assert.equal(cleared.sampleCount, 0);
  });
});

test('seedsFromDb only returns addresses somebody actually observed', () => {
  withDb((db) => {
    const co = insertCompany(db, 'acme.com');

    insertContact(db, co, { first: 'Jane', last: 'Doe', email: 'jane.doe@acme.com', verdict: 'valid' });
    // A pattern guess that was confirmed still counts — it is now a fact.
    insertContact(db, co, {
      first: 'Bob', last: 'Smith', email: 'bob.smith@acme.com', verdict: 'valid', pattern: 'first.last',
    });
    // An unconfirmed pattern guess must not feed inference, or confidence would
    // climb off the back of its own guesses.
    insertContact(db, co, {
      first: 'Amy', last: 'Chen', email: 'amy.chen@acme.com', verdict: 'unknown', pattern: 'first.last',
    });
    insertContact(db, co, { first: 'Raj', last: 'Kumar', email: 'raj@acme.com', verdict: 'invalid' });
    insertContact(db, co, { first: 'Zoe', last: 'Ng', email: 'zoe.ng@other.com', verdict: 'valid' });

    const emails = seedsFromDb(db, 'acme.com').map((s) => s.email).sort();
    assert.deepEqual(emails, ['bob.smith@acme.com', 'jane.doe@acme.com']);
  });
});

test('seedsFromDb picks up observed addresses that never became the contact’s email', () => {
  withDb((db) => {
    const co = insertCompany(db, 'acme.com');
    const contactId = insertContact(db, co, {
      first: 'Jane', last: 'Doe', email: 'jane.doe@acme.com', verdict: 'valid',
    });
    const other = insertContact(db, co, { first: 'Bob', last: 'Smith', email: null as unknown as string });

    run(
      db,
      `INSERT INTO field_observation (entity, entity_id, field, value, source) VALUES (?, ?, ?, ?, ?)`,
      'contact', other, 'email', 'bob.smith@acme.com', 'hn_whoishiring',
    );
    // A pattern-inferred observation is a guess, not evidence.
    run(
      db,
      `INSERT INTO field_observation (entity, entity_id, field, value, source) VALUES (?, ?, ?, ?, ?)`,
      'contact', contactId, 'email', 'j.doe@acme.com', 'pattern_inference',
    );

    const seeds = seedsFromDb(db, 'acme.com');
    const emails = seeds.map((s) => s.email).sort();
    assert.deepEqual(emails, ['bob.smith@acme.com', 'jane.doe@acme.com']);
    assert.equal(seeds.find((s) => s.email === 'bob.smith@acme.com')!.firstName, 'Bob');
  });
});

test('refreshPattern derives and persists a domain’s pattern from the database', () => {
  withDb((db) => {
    const co = insertCompany(db, 'acme.com');
    insertContact(db, co, { first: 'Jane', last: 'Doe', email: 'jdoe@acme.com', verdict: 'valid' });
    insertContact(db, co, { first: 'Bob', last: 'Smith', email: 'bsmith@acme.com', verdict: 'valid' });

    const inferred = refreshPattern(db, 'acme.com');
    assert.equal(inferred.pattern, 'flast');
    assert.equal(inferred.sampleCount, 2);
    assert.equal(inferred.confidence, 2 / 3);

    const stored = loadPattern(db, 'acme.com')!;
    assert.equal(stored.pattern, 'flast');
    assert.equal(stored.confidence, 2 / 3);
    assert.equal(stored.sampleCount, 2);

    // Extra seeds supplied by the caller are folded in with the stored ones.
    const withExtra = refreshPattern(db, 'acme.com', [seed('achen@acme.com', 'Amy', 'Chen')]);
    assert.equal(withExtra.sampleCount, 3);
    assert.equal(withExtra.confidence, 3 / 4);
  });
});
