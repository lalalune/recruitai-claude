/**
 * The single definition of what a `kind = 'company'` suppression matches.
 *
 * History: company suppressions were matched as `s.value = co.id` — but every
 * stored value is lowercased and ULIDs are uppercase, so a pasted id never
 * matched; and the Settings field invites a company *name*, which nothing
 * matched at all. A suppression that does not suppress is the worst kind of
 * bug for an outreach tool, so the matching rules live here, in one place,
 * and every barrier (queue predicate, draft eligibility, CSV export, the
 * last-gate check in gmail/send.ts) uses them.
 */

import { normName } from './ingest.js';
import { get, type Db } from '../db/index.js';

/** ULID as emitted by src/main/db/index.ts — uppercase Crockford, 26 chars. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

/** Something that parses as a bare hostname, e.g. "acme.com". */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Canonical stored form of a company-kind suppression value:
 *   - a ULID     → lowercased (matched back via upper(s.value) = co.id)
 *   - a domain   → lowercased (matched via s.value = lower(co.domain))
 *   - a name     → normName() (matched via s.value = co.name_norm)
 */
export function canonicalCompanyValue(raw: string): string {
  const v = raw.trim();
  if (ULID_RE.test(v)) return v.toLowerCase();
  if (DOMAIN_RE.test(v)) return v.toLowerCase();
  const norm = normName(v);
  return norm || v.toLowerCase();
}

/**
 * Shape alone cannot disambiguate "Node.js" (a NAME that looks like a domain,
 * whose name_norm is 'node js') from "booking.com" (really a domain). When a
 * company already exists, prefer the interpretation that matches it. When
 * NOTHING matches — a pre-emptive blocklist entry for a company not yet
 * ingested — the honest answer is that we cannot know which way it will
 * arrive, so BOTH readings are stored: whichever identity the company later
 * shows up with, one row matches. A suppression that might not suppress is
 * the failure class this module exists to kill.
 */
export function companySuppressionValues(db: Db, raw: string): string[] {
  const shaped = canonicalCompanyValue(raw);
  const asName = normName(raw);
  if (shaped === asName || !asName) return [shaped];

  const shapedHit = get<{ id: string }>(
    db,
    `SELECT id FROM company WHERE id = upper(?) OR name_norm = ? OR (domain IS NOT NULL AND lower(domain) = ?) LIMIT 1`,
    shaped,
    shaped,
    shaped,
  );
  if (shapedHit) return [shaped];

  const nameHit = get<{ id: string }>(db, `SELECT id FROM company WHERE name_norm = ? LIMIT 1`, asName);
  if (nameHit) return [asName];

  return [shaped, asName];
}

/**
 * SQL fragment matching a suppression row `s` of kind 'company' against a
 * company row aliased `co`. Assumes s.value is stored canonically (above).
 */
export const COMPANY_SUPPRESSION_MATCH = `(
  upper(s.value) = co.id
  OR s.value = co.name_norm
  OR (co.domain IS NOT NULL AND s.value = lower(co.domain))
)`;

/**
 * WHERE fragment selecting companies matched by a single canonical value
 * bound three times: (value, value, value). Used at add/remove time.
 */
export const COMPANY_MATCHES_VALUE = `(
  company.id = upper(?)
  OR company.name_norm = ?
  OR (company.domain IS NOT NULL AND lower(company.domain) = ?)
)`;
