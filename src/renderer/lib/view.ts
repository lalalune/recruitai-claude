/**
 * The Review list's filter/search/sort pipeline, extracted pure so node tests
 * can pin it (importing Review.tsx would drag the whole component tree into a
 * DOM-less test bundle).
 */

import type { CompanyRow } from '../../shared/ipc.js';
import type { SortKey } from '../store/ui.js';

export const STALE_DAYS = 45;

export interface ViewToggles {
  hasVerifiedEmail: boolean;
  noInhouseTa: boolean;
  staleOnly: boolean;
}

export function applyView(
  rows: CompanyRow[],
  filter: string,
  toggles: ViewToggles,
  search: string,
  sort: SortKey,
  serverSearchIds: Set<string> | null = null,
): CompanyRow[] {
  const q = search.trim().toLowerCase();

  const out = rows.filter((r) => {
    if (filter === 'unreviewed' && r.reviewed) return false;
    if (filter === 'conflicts' && !r.hasConflict) return false;
    if (filter === 'approved' && r.status !== 'approved') return false;
    if (filter === 'rejected' && r.status !== 'rejected') return false;

    if (toggles.hasVerifiedEmail && r.verifiedContactCount === 0) return false;
    if (toggles.noInhouseTa && r.hasInhouseTa !== false && (r.recruiterCount ?? 1) > 0) return false;
    if (toggles.staleOnly && !(r.staleReqCount > 0 || (r.maxDaysOpen ?? 0) >= STALE_DAYS)) {
      return false;
    }

    if (q) {
      const hay = `${r.name} ${r.domain ?? ''} ${r.industry ?? ''} ${r.ycBatch ?? ''}`.toLowerCase();
      // Local row match OR the server said one of its contacts/reqs matched.
      if (!hay.includes(q) && !(serverSearchIds?.has(r.id) ?? false)) return false;
    }
    return true;
  });

  // `recent` is the order the server returned, so it needs no comparator.
  if (sort === 'recent') return out;

  const cmp: Record<Exclude<SortKey, 'recent'>, (a: CompanyRow, b: CompanyRow) => number> = {
    score: (a, b) => (b.qualityScore ?? -1) - (a.qualityScore ?? -1),
    reqs: (a, b) => b.openReqCount - a.openReqCount,
    days_open: (a, b) => (b.maxDaysOpen ?? -1) - (a.maxDaysOpen ?? -1),
    fee: (a, b) => (b.estimatedFeeUsd ?? -1) - (a.estimatedFeeUsd ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  };

  // Score is the tiebreaker everywhere else so the top of any list stays useful.
  const primary = cmp[sort];
  return out.sort(
    (a, b) => primary(a, b) || (b.qualityScore ?? -1) - (a.qualityScore ?? -1) || a.name.localeCompare(b.name),
  );
}
