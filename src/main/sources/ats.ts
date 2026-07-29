/**
 * ATS public job-board adapters.
 *
 * Every endpoint below was verified live on 2026-07-28 (see VERIFIED-SOURCES.md).
 * All are unauthenticated, key-free, and serve data the company published
 * publicly. Together they are the entire hiring-signal layer, at zero cost.
 *
 * Two of them (Lever, Ashby) return structured salary ranges, which is what makes
 * `estimatedFee = compMidpoint * 0.30` computable without paying anyone.
 */

import { httpRequest, httpJson, type HttpResponse } from '../util/http.js';
import type { AtsBoard, AtsPlatform, DiscoveredJob, SourceResult } from '../../shared/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Greenhouse
// ─────────────────────────────────────────────────────────────────────────────

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  requisition_id?: string;
  content?: string;
  departments?: { name: string }[];
  metadata?: unknown;
}

export async function fetchGreenhouse(
  token: string,
  opts: { withContent?: boolean } = {},
): Promise<SourceResult<AtsBoard>> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs${
    opts.withContent ? '?content=true' : ''
  }`;
  const res = await httpRequest(url);
  if (!res.ok) return fail(res, url);

  const parsed = safeParse<{ jobs: GhJob[] }>(res.body);
  if (!parsed?.jobs) return fail(res, url, 'unexpected shape');

  const jobs: DiscoveredJob[] = parsed.jobs.map((j) => ({
    externalId: String(j.id),
    title: j.title,
    department: j.departments?.[0]?.name ?? null,
    location: j.location?.name ?? null,
    url: j.absolute_url,
    descriptionText: j.content ? stripHtml(decodeEntities(j.content)) : null,
    publishedAt: j.first_published ?? null,
    updatedAt: j.updated_at ?? null,
  }));

  return ok(url, res, { platform: 'greenhouse', token, jobs, fetchedAt: res.fetchedAt, rawBody: res.body });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ashby — dominant among early-stage startups; returns full JD + comp inline
// ─────────────────────────────────────────────────────────────────────────────

interface AshbyJob {
  id: string;
  title: string;
  department?: string | null;
  team?: string | null;
  location?: string | null;
  isRemote?: boolean;
  workplaceType?: string | null;
  employmentType?: string | null;
  publishedAt?: string | null;
  jobUrl: string;
  descriptionPlain?: string | null;
  isListed?: boolean;
  compensation?: {
    scrapeableCompensationSalarySummary?: string | null;
    compensationTierSummary?: string | null;
  } | null;
}

export async function fetchAshby(token: string): Promise<SourceResult<AtsBoard>> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  const res = await httpRequest(url);
  if (!res.ok) return fail(res, url);

  const parsed = safeParse<{ jobs: AshbyJob[] }>(res.body);
  if (!parsed?.jobs) return fail(res, url, 'unexpected shape');

  const jobs: DiscoveredJob[] = parsed.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const comp = parseCompRange(
        j.compensation?.scrapeableCompensationSalarySummary ??
          j.compensation?.compensationTierSummary ??
          null,
      );
      return {
        externalId: j.id,
        title: j.title.trim(),
        department: j.department ?? null,
        team: j.team ?? null,
        location: j.location ?? null,
        isRemote: j.isRemote ?? null,
        employmentType: j.employmentType ?? null,
        compMin: comp?.min ?? null,
        compMax: comp?.max ?? null,
        descriptionText: j.descriptionPlain ?? null,
        url: j.jobUrl,
        publishedAt: j.publishedAt ?? null,
      };
    });

  return ok(url, res, { platform: 'ashby', token, jobs, fetchedAt: res.fetchedAt, rawBody: res.body });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lever — returns a structured salaryRange object
// ─────────────────────────────────────────────────────────────────────────────

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: string | number;
  workplaceType?: string | null;
  descriptionPlain?: string | null;
  categories?: { team?: string; location?: string; commitment?: string; allLocations?: string[] };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } | null;
}

export async function fetchLever(token: string): Promise<SourceResult<AtsBoard>> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  const res = await httpRequest(url);
  if (!res.ok) return fail(res, url);

  const parsed = safeParse<LeverJob[]>(res.body);
  if (!Array.isArray(parsed)) return fail(res, url, 'unexpected shape');

  const jobs: DiscoveredJob[] = parsed.map((j) => {
    // Lever gives per-year, per-hour, etc. Only trust annual figures for fee math.
    const annual = j.salaryRange?.interval === 'per-year-salary';
    return {
      externalId: j.id,
      title: j.text,
      team: j.categories?.team ?? null,
      location: j.categories?.location ?? null,
      isRemote: j.workplaceType === 'remote',
      employmentType: j.categories?.commitment ?? null,
      compMin: annual ? (j.salaryRange?.min ?? null) : null,
      compMax: annual ? (j.salaryRange?.max ?? null) : null,
      descriptionText: j.descriptionPlain ?? null,
      url: j.hostedUrl,
      publishedAt: epochToIso(j.createdAt),
    };
  });

  return ok(url, res, { platform: 'lever', token, jobs, fetchedAt: res.fetchedAt, rawBody: res.body });
}

// ─────────────────────────────────────────────────────────────────────────────
// SmartRecruiters — paginated
// ─────────────────────────────────────────────────────────────────────────────

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  department?: { label?: string };
  typeOfEmployment?: { label?: string };
  ref?: string;
}

export async function fetchSmartRecruiters(token: string): Promise<SourceResult<AtsBoard>> {
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`;
  const all: SrPosting[] = [];
  let offset = 0;
  let firstBody = '';
  let last: HttpResponse | null = null;

  // Cap at 10 pages (1000 postings) — beyond that we're looking at an enterprise
  // that is almost certainly out of ICP anyway.
  let partial = false;
  for (let page = 0; page < 10; page++) {
    const url = `${base}?limit=100&offset=${offset}`;
    const res = await httpRequest(url);
    last = res;
    if (!res.ok) {
      // A failed page 2+ means `all` is a prefix of the board, not the board.
      partial = all.length > 0;
      break;
    }
    if (!firstBody) firstBody = res.body;

    const parsed = safeParse<{ content?: SrPosting[]; totalFound?: number }>(res.body);
    const content = parsed?.content ?? [];
    all.push(...content);
    if (content.length < 100) break;
    offset += 100;
  }

  if (!last?.ok && all.length === 0) return fail(last ?? emptyRes(base), base);

  const jobs: DiscoveredJob[] = all.map((p) => ({
    externalId: p.id,
    title: p.name,
    department: p.department?.label ?? null,
    location: [p.location?.city, p.location?.region].filter(Boolean).join(', ') || null,
    isRemote: p.location?.remote ?? null,
    employmentType: p.typeOfEmployment?.label ?? null,
    url: `https://jobs.smartrecruiters.com/${token}/${p.id}`,
    publishedAt: p.releasedDate ?? null,
  }));

  return ok(base, last ?? emptyRes(base), {
    platform: 'smartrecruiters',
    token,
    jobs,
    fetchedAt: new Date().toISOString(),
    rawBody: firstBody,
    partial,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workable
// ─────────────────────────────────────────────────────────────────────────────

interface WorkableJob {
  id?: string;
  shortcode?: string;
  title: string;
  department?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  remote?: boolean;
  employment_type?: string | null;
  published_on?: string | null;
  url?: string | null;
}

export async function fetchWorkable(token: string): Promise<SourceResult<AtsBoard>> {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`;
  const res = await httpRequest(url);
  if (!res.ok) return fail(res, url);

  const parsed = safeParse<{ name?: string; jobs?: WorkableJob[] }>(res.body);
  if (!parsed) return fail(res, url, 'unexpected shape');

  const jobs: DiscoveredJob[] = (parsed.jobs ?? []).map((j) => ({
    externalId: j.shortcode ?? j.id ?? j.title,
    title: j.title,
    department: j.department ?? null,
    location: [j.city, j.state, j.country].filter(Boolean).join(', ') || null,
    isRemote: j.remote ?? null,
    employmentType: j.employment_type ?? null,
    url: j.url ?? `https://apply.workable.com/${token}/j/${j.shortcode ?? ''}`,
    publishedAt: j.published_on ?? null,
  }));

  return ok(url, res, { platform: 'workable', token, jobs, fetchedAt: res.fetchedAt, rawBody: res.body });
}

// Workday has no adapter on purpose: its API needs (tenant, site, wd-N) and
// nothing in the pipeline can discover those — the careers-crawl records only
// a bare token. A fetcher existed here for two audits while being provably
// unreachable; if Workday support lands, it starts from tenant+site discovery,
// not from a fetcher (see git history for the removed implementation).

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export const ATS_FETCHERS: Record<
  Exclude<AtsPlatform, 'workday'>,
  (token: string) => Promise<SourceResult<AtsBoard>>
> = {
  greenhouse: (t) => fetchGreenhouse(t, { withContent: true }),
  ashby: fetchAshby,
  lever: fetchLever,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
};

/**
 * Probe order matters. Measured on a 60-company sample of YC SF startups:
 * Ashby 15, Greenhouse 8, Lever 2, Teamtailor 1. Ashby dominates early-stage,
 * Greenhouse dominates growth-stage, Lever is in decline. Probing in hit-rate
 * order means most companies resolve on the first request.
 */
export const PROBE_ORDER: Exclude<AtsPlatform, 'workday'>[] = [
  'ashby',
  'greenhouse',
  'lever',
  'workable',
  'smartrecruiters',
];

/** Platforms that have asked us to stop, for the duration of a sweep. */
export type BlockedPlatforms = Set<AtsPlatform>;

export class AllPlatformsBlockedError extends Error {
  constructor() {
    super('Every ATS platform is rate-limiting us — sweep halted.');
    this.name = 'AllPlatformsBlockedError';
  }
}

/** Who the caller believes it is probing for, so an obviously wrong board can
 *  be turned away. Both fields optional — omitted means "no opinion". */
export interface ProbeExpectation {
  name?: string | null;
  domain?: string | null;
}

/**
 * Company display name embedded in a raw board payload, when the platform
 * publishes one (Workable's top-level `name`; some Greenhouse payloads carry
 * `company.name`). Most platforms expose nothing, and that is fine — the
 * collision guard simply passes when there is no signal to check.
 */
function boardCompanyName(rawBody: string | null | undefined): string | null {
  if (!rawBody) return null;
  const parsed = safeParse<{ name?: unknown; company?: { name?: unknown } | null }>(rawBody);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const name =
    (parsed.company && typeof parsed.company === 'object' ? parsed.company.name : undefined) ?? parsed.name;
  return typeof name === 'string' && name.trim().length > 0 ? name : null;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const nameTokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));

/**
 * Token-collision sanity guard.
 *
 * A guessed token can resolve an unrelated company's board — 'atlas', 'linear'
 * and bare first DNS labels all collide with real customers of these
 * platforms. When the caller says who it expected and the payload names who
 * actually answered, an obvious mismatch is rejected.
 *
 * The tradeoff is deliberately tilted toward accepting: a false rejection
 * silently loses a real board (and nothing downstream will ever look again),
 * while a false accept produces visible garbage an operator can suppress. So
 * the guard passes whenever the payload exposes no name, whenever the probed
 * token itself appears in the expected name/domain, and whenever any ≥3-char
 * token is shared between the board's name and the expected identity — it
 * only exists to catch the obvious collisions.
 */
function boardMatchesExpectation(board: AtsBoard, expect: ProbeExpectation): boolean {
  const boardName = boardCompanyName(board.rawBody);
  if (!boardName) return true;

  const expected = [expect.name ?? '', expect.domain ?? ''].join(' ').trim();
  const expectedSquashed = squash(expected);
  if (!expectedSquashed) return true;

  const token = squash(board.token);
  if (token.length >= 3 && expectedSquashed.includes(token)) return true;

  const expectedTokens = nameTokens(expected);
  // No usable expected token (e.g. company "X1", domain x1.com — everything
  // shorter than the 3-char floor): the guard must abstain, not reject. A
  // false rejection silently loses a real board forever.
  if (expectedTokens.size === 0) return true;

  for (const t of nameTokens(boardName)) {
    if (expectedTokens.has(t)) return true;
  }
  return false;
}

/**
 * Try each platform until one returns a board with jobs.
 *
 * A 404 means "not a customer" and is a normal, cheap negative — it is the basis
 * of the free ATS-customer enumeration described in VERIFIED-SOURCES.md.
 *
 * Blocks are tracked PER PLATFORM. Measured behaviour differs sharply between
 * hosts: Workable starts 429-ing after a handful of rapid misses while
 * Greenhouse and Ashby serve hundreds without complaint. Treating one host's
 * 429 as a global stop threw away the whole sweep, so a blocked platform is
 * simply dropped for the rest of the run. We still never retry or evade it —
 * we just stop asking that host, and keep talking to the ones that are happy.
 *
 * When `expect` is provided, a board that names an obviously different company
 * is skipped (see boardMatchesExpectation). Omitting it keeps the old
 * behaviour exactly — tests and the smoke script probe bare tokens.
 */
export async function probeAts(
  token: string,
  blocked: BlockedPlatforms = new Set(),
  expect?: ProbeExpectation,
): Promise<AtsBoard | null> {
  const available = PROBE_ORDER.filter((p) => !blocked.has(p));
  if (available.length === 0) throw new AllPlatformsBlockedError();

  for (const platform of available) {
    const result = await ATS_FETCHERS[platform](token);
    // A 429/403 marks the platform blocked even when data came back with it:
    // SmartRecruiters paginates, so page 1 can succeed and page 2 rate-limit.
    // The postings already fetched are real and are kept.
    if (result.httpStatus === 429 || result.httpStatus === 403) blocked.add(platform);
    if (result.ok && result.data && result.data.jobs.length > 0) {
      if (expect && !boardMatchesExpectation(result.data, expect)) continue;
      return result.data;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ok(url: string, res: HttpResponse, data: AtsBoard): SourceResult<AtsBoard> {
  return { ok: true, data, url, fetchedAt: res.fetchedAt, httpStatus: res.status, rawBody: res.body };
}

function fail(res: HttpResponse, url: string, error?: string): SourceResult<AtsBoard> {
  return {
    ok: false,
    data: null,
    url,
    fetchedAt: res.fetchedAt ?? new Date().toISOString(),
    httpStatus: res.status,
    error: error ?? res.error ?? `HTTP ${res.status}`,
  };
}

function emptyRes(url: string): HttpResponse {
  return { ok: false, status: 0, body: '', url, fetchedAt: new Date().toISOString() };
}

function safeParse<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function epochToIso(v: string | number | undefined): string | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

/**
 * Parse "$211.4K - $290.6K" / "$180,000 — $240,000" into annual numbers.
 * Returns null rather than guessing when the shape is unfamiliar — a wrong comp
 * figure propagates into the fee estimate and corrupts the ranking.
 */
export function parseCompRange(s: string | null): { min: number; max: number } | null {
  if (!s) return null;
  const matches = [...s.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*([KkMm])?/g)];
  if (matches.length < 2) return null;

  const nums = matches.slice(0, 2).map((m) => {
    let n = parseFloat(m[1]!.replace(/,/g, ''));
    const suffix = m[2]?.toLowerCase();
    if (suffix === 'k') n *= 1_000;
    else if (suffix === 'm') n *= 1_000_000;
    return n;
  });

  const [min, max] = nums as [number, number];
  // Reject hourly/equity-only figures that slipped through.
  if (min < 20_000 || max > 2_000_000 || max < min) return null;
  return { min, max };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
