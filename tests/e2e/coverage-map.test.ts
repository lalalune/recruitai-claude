/**
 * A coverage map, not a coverage percentage.
 *
 * Line coverage answers "was this executed", which is the wrong question for a
 * tool that emails strangers on the operator's behalf. The question that
 * matters is "does the function that decides who gets emailed, what it says,
 * how fast it goes out, and what it costs, have a test that names it".
 *
 * So this enumerates every export under src/main and src/shared, then asserts
 * that a small, explicit list of money-path exports is each named by at least
 * one test. It fails in exactly two ways, and both are the point:
 *
 *   - a critical export is renamed or deleted → the list no longer resolves,
 *     which is louder than a stale test that silently stops covering anything;
 *   - a critical export loses its last test → the gap is visible in CI on the
 *     commit that opened it, rather than discovered during an incident.
 *
 * The list is deliberately SMALL. It is not an inventory of everything worth
 * testing; it is the set of things that must never be silently uncovered.
 * Matching is by NAME across the whole tree, so moving a function between
 * modules is free and only a rename or a deletion trips it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Locating the sources (the bundle runs from dist/tests)
// ─────────────────────────────────────────────────────────────────────────────

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'main', 'pipeline', 'drafts.ts'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate the repo root from ${process.cwd()}`);
}

const ROOT = repoRoot();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  return [...walk(path.join(ROOT, 'src', 'main')), ...walk(path.join(ROOT, 'src', 'shared'))].sort();
}

function testFiles(): string[] {
  return ['tests/unit', 'tests/e2e']
    .flatMap((d) => {
      const dir = path.join(ROOT, d);
      return fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f))
        : [];
    })
    .sort();
}

/** Strips comments so a name discussed in prose is not counted as covered. */
function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/**
 * Value exports only. Types and interfaces are deliberately excluded: a type has
 * no behaviour to cover, and counting them would pad the map with names no test
 * could meaningfully "reference".
 */
const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function enumerateExports(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const code = codeWithoutComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(EXPORT_RE)) {
      const name = m[1]!;
      const rel = path.relative(ROOT, file);
      const list = map.get(name);
      if (list) list.push(rel);
      else map.set(name, [rel]);
    }
  }
  return map;
}

function testCorpus(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of testFiles()) {
    out.set(path.relative(ROOT, file), codeWithoutComments(fs.readFileSync(file, 'utf8')));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grouped by the question each group answers. Every entry is on a path where a
 * silent regression costs money, sends a wrong message, or burns the sending
 * account — nothing is here because it looked important.
 */
const CRITICAL: Record<string, string[]> = {
  // Who is worth contacting, and what a placement is worth.
  'scoring and fee estimation': [
    'scoreCompany',
    'scoreContact',
    'estimateReqFee',
    'estimateTotalFee',
    'daysOpen',
    'isEngineering',
    'looksLikeRecruitingAgency',
    'recomputeCompany',
  ],

  // Whether an address is real enough to write to. A wrong verdict here either
  // wastes a send or bounces one, and bounces are what get an account flagged.
  'verification verdicts': ['decideContact', 'inferPattern', 'patternConformance', 'generateCandidates'],

  // What the human actually reads.
  'draft generation': [
    'bandFor',
    'renderSubject',
    'renderBody',
    'generateDraftFor',
    'rewriteBodyProse',
    'renderTemplate',
    'assembleEmail',
    'ensureCompliantFooter',
  ],

  // How fast it leaves, and whether it may leave at all.
  'send caps and suppression': [
    'sendOne',
    'sentToday',
    'sentThisHour',
    'isInSendWindow',
    'queuedCount',
    'reconcileInterruptedSends',
    'markInbound',
    'canonicalCompanyValue',
    'companySuppressionValues',
    'isSuppressed',
  ],

  // The guard against a runaway loop spending real money overnight.
  'cost ledger': [
    'reserveApiCall',
    'commitApiCall',
    'releaseApiCall',
    'totalSpentMicros',
    'SpendCapExceeded',
  ],

  // The bytes on the wire, and the bytes that come back.
  'wire format': ['buildRawMessage', 'parseDeliveryStatus', 'SEND_ID_HEADER'],
};

const CRITICAL_NAMES = Object.values(CRITICAL).flat();

// ─────────────────────────────────────────────────────────────────────────────

describe('coverage map', () => {
  test('coverage map the enumeration finds the codebase it is supposed to guard', () => {
    const exports = enumerateExports();
    const sources = sourceFiles();
    const tests = testFiles();

    // Sanity floors. If a refactor moves the tree, this fails loudly here
    // rather than by silently reporting that every critical export is missing.
    assert.ok(sources.length >= 25, `only found ${sources.length} source files under src/main and src/shared`);
    assert.ok(tests.length >= 15, `only found ${tests.length} test files`);
    assert.ok(exports.size >= 150, `only enumerated ${exports.size} exports`);

    // The list must have no duplicates: a name listed twice quietly halves the
    // signal from any group it appears in.
    assert.equal(
      new Set(CRITICAL_NAMES).size,
      CRITICAL_NAMES.length,
      'the critical list contains a duplicate name',
    );
  });

  test('coverage map every critical name still exists as an export', () => {
    const exports = enumerateExports();
    const missing = CRITICAL_NAMES.filter((name) => !exports.has(name));

    assert.deepEqual(
      missing,
      [],
      `these critical exports no longer exist — they were renamed or deleted, and any test naming ` +
        `them is now testing nothing. Update the list in this file along with the rename:\n  ${missing.join('\n  ')}`,
    );
  });

  test('coverage map every critical export is named by at least one test', () => {
    const corpus = testCorpus();
    const uncovered: string[] = [];

    for (const [group, names] of Object.entries(CRITICAL)) {
      for (const name of names) {
        const word = new RegExp(`\\b${name}\\b`);
        const covered = [...corpus].some(([, code]) => word.test(code));
        if (!covered) uncovered.push(`${name}  (${group})`);
      }
    }

    assert.deepEqual(
      uncovered,
      [],
      `these money-path exports have no test that names them:\n  ${uncovered.join('\n  ')}\n` +
        `Write one, or argue in this file's list why it does not belong there.`,
    );
  });

  test('coverage map no critical name is so overloaded that name-based coverage stops meaning anything', () => {
    // Coverage here is decided by NAME, which is what makes it survive a file
    // move. The price is that a name defined in many modules dilutes the
    // signal: a test naming one definition would mark all of them covered.
    // Two is tolerable and already the case (`totalSpentMicros` is defined by
    // both the task ledger and the verifier); more is not.
    const exports = enumerateExports();
    const overloaded = CRITICAL_NAMES.filter((n) => (exports.get(n) ?? []).length > 2)
      .map((n) => `${n}: ${exports.get(n)!.join(', ')}`)
      .sort();

    assert.deepEqual(
      overloaded,
      [],
      'a critical export name is defined in three or more modules; a test naming one of them would ' +
        'mark every definition covered. Rename, or drop the name from the critical list.',
    );
  });
});
