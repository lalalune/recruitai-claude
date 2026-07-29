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

import { normName, canonicalCompanyValue } from './canon.js';
import { get, type Db } from '../db/index.js';

// The shaping rules live in canon.ts (a leaf module, so db/index.ts can run
// the post-migration backfill without an import cycle); re-exported here
// because every barrier historically imports them from this module.
export { canonicalCompanyValue } from './canon.js';

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
 * company row aliased `co`. Assumes s.value is stored canonically (above;
 * migration v3 normalises legacy rows).
 *
 * The indexed suppression side stays a BARE column — `s.value = lower(co.id)`
 * seeks the UNIQUE(kind, value) index, while the old `upper(s.value) = co.id`
 * degraded every barrier to a per-kind scan (measured 85x on the send path).
 */
export const COMPANY_SUPPRESSION_MATCH = `(
  s.value = lower(co.id)
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
