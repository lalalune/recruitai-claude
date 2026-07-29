/**
 * Email pattern inference — the biggest cost lever in the pipeline.
 *
 * One confirmed address at a domain turns every named person at that domain
 * into a candidate address, which is the difference between paying to verify
 * one guess per person and paying to verify five.
 *
 * ON CONFIDENCE NUMBERS, DELIBERATELY:
 * There is no hardcoded accuracy constant anywhere in this file. The widely
 * repeated "87% / 97% accurate pattern inference" figures are vendor marketing
 * for a paid database lookup and measure a different method entirely — they do
 * not describe inferring a pattern from a handful of observed addresses, and
 * importing them here would mean shipping a number nobody in this codebase can
 * defend. Instead `email_pattern.confidence` holds a value computed from THIS
 * operator's own observed samples (Laplace-smoothed agreement among seeds),
 * and `measuredPatternAccuracy()` reports the operator's real, measured hit
 * rate of pattern-generated addresses against verifier verdicts. Both are
 * facts about this database, not claims from a brochure.
 */

import { type Db, all, get, run } from '../db/index.js';
import { domainOf, isRoleAccount, localPartOf, normalizeEmail } from './mx.js';

export type EmailPattern =
  | 'first.last'
  | 'firstlast'
  | 'flast'
  | 'first_last'
  | 'first'
  | 'f.last'
  | 'lastf'
  | 'first-last'
  | 'firstl';

export const ALL_PATTERNS: EmailPattern[] = [
  'first.last',
  'firstlast',
  'flast',
  'first_last',
  'first',
  'f.last',
  'lastf',
  'first-last',
  'firstl',
];

/**
 * Fallback ordering used only when this database has no observations to order
 * by. It is a shape-of-the-world prior, not an accuracy claim; as soon as the
 * operator has verified anything, `globalPatternOrder()` replaces it with the
 * ordering measured from their own data.
 */
const FALLBACK_ORDER: EmailPattern[] = [
  'first.last',
  'first',
  'flast',
  'firstlast',
  'f.last',
  'first_last',
  'firstl',
  'lastf',
  'first-last',
];

export interface KnownAddress {
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface InferredPattern {
  pattern: EmailPattern | null;
  /** 0-1, computed from the samples below. See the file header. */
  confidence: number;
  sampleCount: number;
  /** Weighted count of samples that agree with the winning pattern. */
  agreeing: number;
  /** Every pattern that got any support, best first. */
  ranked: { pattern: EmailPattern; support: number }[];
}

export interface Candidate {
  email: string;
  localPart: string;
  pattern: EmailPattern;
  /** 0 is the best guess. */
  rank: number;
  /** Confidence carried from the domain's inferred pattern, else 0. */
  confidence: number;
  fromKnownPattern: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name normalisation
// ─────────────────────────────────────────────────────────────────────────────

const COMBINING_MARKS = /[\u0300-\u036f]/g;

const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'der', 'den', 'di', 'da', 'do', 'dos', 'la', 'le', 'du', 'st', 'saint', 'mac', 'mc', 'bin', 'ibn', 'al']);

/** Strip diacritics and anything that cannot appear in a local part. */
export function normalizeNamePart(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * A surname of "van der Berg" is written vanderberg in a local part far more
 * often than it is written berg, so particles are joined rather than dropped.
 */
export function normalizeLastName(raw: string | null | undefined): string {
  if (!raw) return '';
  const tokens = raw
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .split(/[\s'’]+/)
    .map((t) => t.replace(/[^a-z-]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.join('').replace(/-/g, '');
}

/** Drops suffixes and middle names; returns the pair we build addresses from. */
export function splitFullName(fullName: string): { first: string; last: string } {
  const cleaned = fullName
    .replace(/["“”]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|phd|ph\.?d|md|mba|cpa)\b\.?/gi, ' ')
    .trim();
  // Anything with no letters left (a stray "." from a stripped suffix, a bullet)
  // is punctuation, not a name token.
  const parts = cleaned.split(/[\s,]+/).filter((p) => /[a-z]/i.test(p));
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };

  // Pull trailing particles back onto the surname: "Jan van der Berg".
  let lastStart = parts.length - 1;
  while (lastStart > 1 && PARTICLES.has(normalizeNamePart(parts[lastStart - 1]!))) lastStart--;
  return { first: parts[0]!, last: parts.slice(lastStart).join(' ') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering and matching
// ─────────────────────────────────────────────────────────────────────────────

export function needsLastName(pattern: EmailPattern): boolean {
  return pattern !== 'first';
}

/** Returns the local part a pattern produces, or '' if the names cannot fill it. */
export function renderPattern(pattern: EmailPattern, firstName: string, lastName: string): string {
  const f = normalizeNamePart(firstName);
  const l = normalizeLastName(lastName);
  if (!f) return '';
  if (needsLastName(pattern) && !l) return '';

  switch (pattern) {
    case 'first.last':
      return `${f}.${l}`;
    case 'firstlast':
      return `${f}${l}`;
    case 'flast':
      return `${f[0]}${l}`;
    case 'first_last':
      return `${f}_${l}`;
    case 'first':
      return f;
    case 'f.last':
      return `${f[0]}.${l}`;
    case 'lastf':
      return `${l}${f[0]}`;
    case 'first-last':
      return `${f}-${l}`;
    case 'firstl':
      return `${f}${l[0]}`;
  }
}

export function buildEmail(
  pattern: EmailPattern,
  firstName: string,
  lastName: string,
  domain: string,
): string {
  const local = renderPattern(pattern, firstName, lastName);
  if (!local) return '';
  return `${local}@${domain.toLowerCase()}`;
}

/**
 * Every pattern that would produce this address for this person. More than one
 * can match (`j@` + `doe` is both `flast` and `firstlast` when the first name
 * is a single letter), which is why support is shared rather than assigned.
 */
export function detectPatterns(
  email: string,
  firstName: string | null,
  lastName: string | null,
): EmailPattern[] {
  const local = localPartOf(normalizeEmail(email)).split('+')[0] ?? '';
  if (!local || !firstName) return [];
  const matches: EmailPattern[] = [];
  for (const p of ALL_PATTERNS) {
    if (needsLastName(p) && !lastName) continue;
    const rendered = renderPattern(p, firstName, lastName ?? '');
    if (rendered && rendered === local) matches.push(p);
  }
  return matches;
}

/**
 * How well an address conforms to the domain's known pattern. 1 means it is
 * exactly what the pattern predicts; 0 means it contradicts it. Used by the
 * decision table, not to decide whether to spend money.
 */
export function patternConformance(
  email: string,
  firstName: string | null,
  lastName: string | null,
  pattern: EmailPattern | null,
  patternConfidence = 0,
): number {
  const matches = detectPatterns(email, firstName, lastName);
  if (matches.length === 0) {
    // No pattern at all matches a first/last pair — could be a nickname or an
    // entirely different scheme. Neutral-low rather than zero.
    return firstName ? 0.15 : 0;
  }
  if (!pattern) return 0.5;
  return matches.includes(pattern) ? Math.max(0.6, patternConfidence) : 0.2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inference
// ─────────────────────────────────────────────────────────────────────────────

export function inferPattern(domain: string, knownAddresses: KnownAddress[]): InferredPattern {
  const d = domain.toLowerCase();
  const support = new Map<EmailPattern, number>();
  let usable = 0;
  const seen = new Set<string>();

  for (const k of knownAddresses) {
    const email = normalizeEmail(k.email);
    if (!email || domainOf(email) !== d) continue;
    if (isRoleAccount(email)) continue; // shared mailboxes say nothing about the scheme
    if (seen.has(email)) continue;
    seen.add(email);
    if (!k.firstName) continue;

    usable++;
    const matches = detectPatterns(email, k.firstName, k.lastName);
    if (matches.length === 0) continue;
    const share = 1 / matches.length;
    for (const m of matches) support.set(m, (support.get(m) ?? 0) + share);
  }

  const ranked = [...support.entries()]
    .map(([pattern, s]) => ({ pattern, support: s }))
    .sort((a, b) => b.support - a.support || ALL_PATTERNS.indexOf(a.pattern) - ALL_PATTERNS.indexOf(b.pattern));

  if (usable === 0 || ranked.length === 0) {
    return { pattern: null, confidence: 0, sampleCount: usable, agreeing: 0, ranked: [] };
  }

  const best = ranked[0]!;

  // Laplace-smoothed agreement: agreeing / (samples + 1). One agreeing sample
  // out of one gives 0.5, five out of five gives 0.83, and a sample that
  // matches no pattern (or matches a different one) drags it down. The +1 is
  // there so a single observation can never read as certainty.
  const confidence = best.support / (usable + 1);

  return {
    pattern: best.pattern,
    confidence: Math.min(0.95, confidence),
    sampleCount: usable,
    agreeing: best.support,
    ranked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate generation
// ─────────────────────────────────────────────────────────────────────────────

export function generateCandidates(
  firstName: string | null,
  lastName: string | null,
  domain: string,
  pattern: EmailPattern | null = null,
  opts: { limit?: number; confidence?: number; order?: EmailPattern[] } = {},
): Candidate[] {
  const limit = opts.limit ?? 5;
  const confidence = opts.confidence ?? 0;
  const d = domain.toLowerCase().replace(/^@/, '');
  if (!d || !firstName) return [];

  const order: EmailPattern[] = [];
  if (pattern) order.push(pattern);
  for (const p of opts.order ?? FALLBACK_ORDER) {
    if (!order.includes(p)) order.push(p);
  }

  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const p of order) {
    if (out.length >= limit) break;
    const email = buildEmail(p, firstName, lastName ?? '', d);
    if (!email || seen.has(email)) continue;
    // A generated address that lands on a shared mailbox ("info@", because the
    // person's first name happens to be a role word) is never a person.
    if (isRoleAccount(email)) continue;
    seen.add(email);
    out.push({
      email,
      localPart: localPartOf(email),
      pattern: p,
      rank: out.length,
      confidence: pattern && p === pattern ? confidence : 0,
      fromKnownPattern: Boolean(pattern) && p === pattern,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeds — free, already in the database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seeds come only from addresses somebody actually observed: emails embedded in
 * HN Who's-Hiring posts, contacts named in job descriptions, careers/team page
 * extractions, and anything the operator typed by hand.
 *
 * Pattern-generated addresses are excluded unless a verifier confirmed them —
 * otherwise the inference would confirm its own guesses and confidence would
 * climb without a single new fact entering the system.
 */
export function seedsFromDb(db: Db, domain: string): KnownAddress[] {
  const d = domain.toLowerCase();
  const like = `%@${d}`;

  const fromContacts = all<{ first_name: string | null; last_name: string | null; email: string }>(
    db,
    `SELECT first_name, last_name, email
       FROM contact
      WHERE email IS NOT NULL
        AND lower(email) LIKE ?
        AND first_name IS NOT NULL
        AND email_verdict NOT IN ('invalid','disposable')
        AND (email_pattern IS NULL OR email_pattern = '' OR email_verdict = 'valid')`,
    like,
  );

  const seeds: KnownAddress[] = fromContacts.map((r) => ({
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
  }));

  // Observations carry addresses that never became contact rows — a JD naming
  // "reach out to jane@acme.com (Jane Doe, Head of Talent)", for instance.
  const fromObs = all<{ value: string | null; entity_id: string }>(
    db,
    `SELECT fo.value, fo.entity_id
       FROM field_observation fo
      WHERE fo.entity = 'contact'
        AND fo.field = 'email'
        AND fo.value IS NOT NULL
        AND lower(fo.value) LIKE ?
        AND fo.source <> 'pattern_inference'`,
    like,
  );

  const known = new Set(seeds.map((s) => normalizeEmail(s.email)));
  for (const o of fromObs) {
    const email = normalizeEmail(o.value);
    if (!email || known.has(email)) continue;
    const c = get<{ first_name: string | null; last_name: string | null }>(
      db,
      'SELECT first_name, last_name FROM contact WHERE id = ?',
      o.entity_id,
    );
    if (!c?.first_name) continue;
    known.add(email);
    seeds.push({ email, firstName: c.first_name, lastName: c.last_name });
  }

  return seeds;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredPattern {
  domain: string;
  pattern: EmailPattern | null;
  confidence: number;
  sampleCount: number;
  mxProvider: string | null;
  isCatchAll: boolean | null;
  updatedAt: number;
}

export function loadPattern(db: Db, domain: string): StoredPattern | null {
  const row = get<{
    domain: string;
    pattern: string;
    sample_count: number;
    confidence: number;
    mx_provider: string | null;
    is_catch_all: number | null;
    updated_at: number;
  }>(db, 'SELECT * FROM email_pattern WHERE domain = ?', domain.toLowerCase());
  if (!row) return null;
  return {
    domain: row.domain,
    pattern: row.pattern ? (row.pattern as EmailPattern) : null,
    confidence: row.confidence,
    sampleCount: row.sample_count,
    mxProvider: row.mx_provider,
    isCatchAll: row.is_catch_all == null ? null : row.is_catch_all === 1,
    updatedAt: row.updated_at,
  };
}

export function savePattern(db: Db, domain: string, inferred: InferredPattern): void {
  run(
    db,
    `INSERT INTO email_pattern (domain, pattern, sample_count, confidence, updated_at)
     VALUES (?, ?, ?, ?, unixepoch('subsec')*1000)
     ON CONFLICT(domain) DO UPDATE SET
       pattern      = excluded.pattern,
       sample_count = excluded.sample_count,
       confidence   = excluded.confidence,
       updated_at   = excluded.updated_at`,
    domain.toLowerCase(),
    inferred.pattern ?? '',
    inferred.sampleCount,
    inferred.confidence,
  );
}

/** Re-derive a domain's pattern from every seed currently in the database. */
export function refreshPattern(db: Db, domain: string, extraSeeds: KnownAddress[] = []): InferredPattern {
  const seeds = [...seedsFromDb(db, domain), ...extraSeeds];
  const inferred = inferPattern(domain, seeds);
  savePattern(db, domain, inferred);
  return inferred;
}

/**
 * Pattern ordering measured from this operator's own confirmed domains. Falls
 * back to FALLBACK_ORDER for patterns that have never been observed here.
 */
export function globalPatternOrder(db: Db): EmailPattern[] {
  const rows = all<{ pattern: string; n: number; conf: number }>(
    db,
    `SELECT pattern, count(*) AS n, avg(confidence) AS conf
       FROM email_pattern
      WHERE pattern <> '' AND sample_count > 0
      GROUP BY pattern`,
  );
  const weight = new Map<string, number>();
  for (const r of rows) weight.set(r.pattern, r.n * Math.max(r.conf, 0.1));

  const observed = ALL_PATTERNS.filter((p) => weight.has(p)).sort(
    (a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0),
  );
  return [...observed, ...FALLBACK_ORDER.filter((p) => !observed.includes(p))];
}

/**
 * The operator's real hit rate for pattern-generated addresses, measured
 * against verifier verdicts on this machine. This is the number to trust when
 * deciding how many candidates per person are worth paying for — not any
 * published figure. Returns null rate until there is anything to measure.
 */
export function measuredPatternAccuracy(
  db: Db,
  pattern?: EmailPattern,
): { attempts: number; valid: number; invalid: number; inconclusive: number; rate: number | null } {
  const rows = pattern
    ? all<{ email_verdict: string; n: number }>(
        db,
        `SELECT email_verdict, count(*) AS n FROM contact
          WHERE email_pattern = ? AND email_verified_at IS NOT NULL
          GROUP BY email_verdict`,
        pattern,
      )
    : all<{ email_verdict: string; n: number }>(
        db,
        `SELECT email_verdict, count(*) AS n FROM contact
          WHERE email_pattern IS NOT NULL AND email_pattern <> '' AND email_verified_at IS NOT NULL
          GROUP BY email_verdict`,
      );

  let valid = 0;
  let invalid = 0;
  let inconclusive = 0;
  for (const r of rows) {
    if (r.email_verdict === 'valid') valid += r.n;
    else if (r.email_verdict === 'invalid' || r.email_verdict === 'disposable') invalid += r.n;
    else inconclusive += r.n;
  }
  const decided = valid + invalid;
  return {
    attempts: valid + invalid + inconclusive,
    valid,
    invalid,
    inconclusive,
    rate: decided > 0 ? valid / decided : null,
  };
}
