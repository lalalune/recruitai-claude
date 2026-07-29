/**
 * Canonical identity forms — name normalisation and company-suppression value
 * shaping. A LEAF module on purpose: db/index.ts runs the one-time Unicode
 * backfill after migrations, so these helpers must not import the db layer
 * (or anything that does) or the bundle gains an import cycle at its root.
 */

import { domainToASCII } from 'node:url';

const LEGAL_SUFFIX_RE =
  /[,.]?\s*\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|bv|sarl|pbc|plc|ag|oy|ab|as|pty|sa)\b\.?$/gi;

/**
 * Unicode-aware: \p{L}\p{N} keeps CJK/Cyrillic/Arabic letters where the old
 * [^a-z0-9] class deleted them — a company named 株式会社テストラボ normalised
 * to '' and every name-keyed barrier (dedupe, suppression) silently missed it.
 * Diacritics still fold to ASCII first (NFKD + combining-mark strip), so
 * 'Café' and 'Cafe' stay the same identity.
 */
export function normName(name: string): string {
  let n = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  for (let i = 0; i < 3; i++) n = n.replace(LEGAL_SUFFIX_RE, '').trim();
  // \p{M} keeps combining marks the Latin strip above did not fold: NFKD
  // splits voiced kana (\u30dc \u2192 \u30db + U+3099), and dropping the mark would turn
  // "bo" into "ho" \u2014 a different word. NFC recomposes them at the end.
  return n
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .normalize('NFC');
}

/** ULID as emitted by src/main/db/index.ts — uppercase Crockford, 26 chars. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

/** Something that parses as a bare hostname, e.g. "acme.com". */
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Canonical stored form of a company-kind suppression value:
 *   - a ULID           → lowercased (matched back via s.value = lower(co.id))
 *   - a domain         → lowercased; an INTERNATIONALISED domain (bücher.de)
 *                        converts to punycode first, because company.domain
 *                        only ever stores ASCII (etldPlusOne rejects the rest)
 *                        and a unicode-form value would match nothing
 *   - a name           → normName() (matched via s.value = co.name_norm)
 */
/**
 * Canonical stored form of a domain-kind suppression value. company.domain is
 * always ASCII (etldPlusOne rejects the rest), so an internationalised domain
 * typed in its unicode form (bücher.de) must be stored as punycode or it will
 * never match anything.
 */
export function canonicalDomainValue(raw: string): string {
  const v = raw.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(v)) return v;
  const puny = domainToASCII(v);
  return puny ? puny.toLowerCase() : v;
}

export function canonicalCompanyValue(raw: string): string {
  const v = raw.trim();
  if (ULID_RE.test(v)) return v.toLowerCase();
  if (DOMAIN_RE.test(v)) return v.toLowerCase();
  if (v.includes('.') && !/\s/.test(v)) {
    const puny = domainToASCII(v);
    if (puny && DOMAIN_RE.test(puny)) return puny.toLowerCase();
  }
  const norm = normName(v);
  return norm || v.toLowerCase();
}
