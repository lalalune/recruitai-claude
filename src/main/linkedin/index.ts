/**
 * LinkedIn identification module — public surface.
 *
 * The operator has decided to use their own logged-in session for personal,
 * internal use. This module implements that decision as narrowly as possible:
 *
 *   • It reads identification fields only — name, headline/title, public
 *     profile URL, current company, and company-level headcount / industry /
 *     employee counts by title keyword. It never reads, derives or stores an
 *     email address or phone number from LinkedIn. Contact values come from
 *     the verification module. A lost session therefore costs a scraping run,
 *     not the contact database.
 *   • It runs in a real Chromium window on a persistent partition, so nothing
 *     about the traffic is a reconstruction or an impersonation of a browser.
 *   • It stops permanently for the day on 429, 999, /checkpoint/ or an auth
 *     wall, shows the operator the page, and never retries, rotates or
 *     attempts to solve a challenge.
 *
 * ── GRACEFUL DEGRADATION ────────────────────────────────────────────────────
 * This module will eventually break, so nothing may depend on it. Every data
 * function returns null when it cannot produce a trustworthy answer, and
 * `isAvailable()` tells a caller up front not to bother.
 *
 * Verified against src/shared/score.ts: `scoreAgencyFit` awards 7 of 15 points
 * with the reason "in-house TA unknown" when `company.recruiterCount` is null,
 * which is the intended neutral outcome. Note the ordering in that function —
 * `recruiters === 0 || hasInhouseTa === false` is tested FIRST and awards the
 * full 15 points, so a fabricated or defaulted 0 would silently promote every
 * company a failed scrape touched. `countRecruiters()` returns null rather
 * than 0 for every inconclusive outcome specifically to protect that.
 *
 * ── FREE FALLBACKS COVERING THE SAME NEED ───────────────────────────────────
 * The question LinkedIn answers here is "does this company already have
 * in-house talent acquisition, and who decides?". Several free sources answer
 * it well enough, and none of them can be revoked:
 *
 *   1. Company team / about / people pages — a startup that has a recruiter
 *      almost always lists them; the same page names the founders and CTO.
 *   2. Job descriptions — an in-house TA function shows up as "you'll work
 *      with our recruiting team", a structured interview loop, or an internal
 *      referral bonus. Many JDs name the hiring manager outright, and the
 *      presence of a "Recruiter" or "Talent Partner" req is itself definitive.
 *   3. The ATS itself — a company posting through Greenhouse or Ashby with
 *      structured departments is far more likely to have in-house TA than one
 *      posting a Notion page.
 *   4. HN "Who is hiring" posts — usually written and signed by a founder or
 *      engineering lead, with a direct reply address.
 *   5. SEC Form D filings — officer and director names, free, authoritative,
 *      and the funding date is the trigger event the scoring engine wants.
 *
 * Those five cover the majority of the signal at zero risk. LinkedIn is the
 * precision layer on top, not the foundation.
 */

export type {
  LinkedInStatus,
  LinkedInState,
  LoginResult,
  SlotResult,
} from './session.js';

export {
  LINKEDIN_PARTITION,
  isAvailable,
  isLoggedIn,
  openLoginWindow,
  logout,
  getCsrfToken,
  getStatus,
  getBudgetRemaining,
  getPerDayBudget,
  isEnabled,
  haltForToday,
  clearHalt,
  showCheckpointWindow,
  onStatusChange,
  emitStatus,
} from './session.js';

export type {
  LinkedInPerson,
  LinkedInCompany,
  RecruiterSignal,
  TitleKeywordCount,
} from './extract.js';

export {
  countRecruiters,
  findDecisionMakers,
  countByTitleKeywords,
  getCompanyProfile,
  companySlug,
  personaFromTitle,
  matchesRecruiterTitle,
  closeWorkerWindow,
} from './extract.js';

/** Renderable in the UI when the module is unavailable, so the operator sees a route forward. */
export const LINKEDIN_FALLBACKS: { label: string; detail: string }[] = [
  {
    label: 'Company team / about page',
    detail: 'A startup with a recruiter almost always lists them, alongside the founders and CTO.',
  },
  {
    label: 'Job descriptions',
    detail:
      'An open "Recruiter" or "Talent Partner" req is definitive; JD language about a recruiting team or referral bonus is strong evidence, and many JDs name the hiring manager.',
  },
  {
    label: 'ATS platform in use',
    detail: 'Structured Greenhouse/Ashby boards imply a real in-house hiring process.',
  },
  {
    label: 'HN "Who is hiring" posts',
    detail: 'Usually signed by a founder or engineering lead, with a direct reply address.',
  },
  {
    label: 'SEC Form D filings',
    detail: 'Officer and director names plus the funding date, free and authoritative.',
  },
];
