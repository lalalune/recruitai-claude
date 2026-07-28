/**
 * Company LinkedIn URL discovery.
 *
 * The LinkedIn module is keyed on a company's LinkedIn URL, and nothing else in
 * the pipeline produces one — YC's dataset has no LinkedIn field and ATS boards
 * never mention it. Without this step the whole LinkedIn feature is unreachable.
 *
 * Almost every company links its own LinkedIn page from its site footer.
 * Measured on 12 seeded companies: 11 resolved from the homepage alone (92%).
 *
 * The slugs are frequently NOT derivable from the domain — measured examples:
 *   sift.com            -> /company/getsift
 *   clerky.com          -> /company/clerky-inc-
 *   polleverywhere.com  -> /company/poll-everywhere-inc.
 * So guessing is not a substitute for reading the page.
 *
 * This reads a company's own public homepage. It never touches linkedin.com.
 */

import { httpRequest } from '../util/http.js';

/**
 * Matches linkedin.com/company/<slug> in href attributes, JSON-LD `sameAs`
 * blocks, and inline scripts alike. Country subdomains (uk., de., …) are common
 * on localised sites and resolve to the same company page.
 */
const COMPANY_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9_%\-.]+)/i;

/** Paths a company's social links realistically appear on, cheapest first. */
const PATHS = ['', '/about', '/contact', '/company'];

/**
 * Slugs that are never a company: LinkedIn's own marketing pages, and the
 * artefacts of a share-intent or tracking URL being matched instead of a profile.
 */
// Lowercase — the lookup normalises case before checking.
const RESERVED = new Set([
  'setup', 'admin', 'login', 'signup', 'unavailable', 'linkedin',
  'showcase', 'school', 'directory', 'feed', 'sharearticle', 'sharing',
  'shareapp', 'company', 'about', 'help', 'legal', 'privacy',
]);

export interface SocialProfile {
  linkedinUrl: string;
  slug: string;
  /** The page we actually found it on — recorded as evidence. */
  foundAt: string;
}

/** Trailing punctuation is common when the match came from prose or JSON. */
function cleanSlug(raw: string): string | null {
  let slug = raw.trim().replace(/%2F/gi, '').replace(/[),;'"]+$/, '');
  // A trailing dot is legitimate in some slugs ("poll-everywhere-inc.") but a
  // trailing slash or query fragment is not.
  slug = slug.split(/[/?#]/)[0] ?? '';
  if (!slug || slug.length > 100) return null;
  if (RESERVED.has(slug.toLowerCase())) return null;
  // A slug of pure digits is almost always a tracking id, not a company.
  if (/^\d+$/.test(slug)) return null;
  return slug;
}

export function extractLinkedInSlug(html: string): string | null {
  const m = html.match(COMPANY_RE);
  return m?.[1] ? cleanSlug(m[1]) : null;
}

/**
 * Fetch a company's site and pull its LinkedIn company URL out.
 *
 * Returns null rather than guessing. A wrong LinkedIn URL is worse than none:
 * it would attribute another company's recruiter headcount to this one and
 * corrupt the single highest-signal input to the score.
 */
export async function findCompanyLinkedIn(website: string): Promise<SocialProfile | null> {
  const base = website.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;

  for (const path of PATHS) {
    const url = base + path;
    const res = await httpRequest(url, { maxRetries: 0, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });

    // The company's own site telling us to stop is still a stop.
    if (res.blocked) return null;
    if (!res.ok || !res.body) continue;

    const slug = extractLinkedInSlug(res.body);
    if (slug) {
      return {
        slug,
        linkedinUrl: `https://www.linkedin.com/company/${slug}`,
        foundAt: url,
      };
    }
  }
  return null;
}
