/**
 * Seed sources — free company lists that feed the ATS sweep.
 *
 * Seeding from real company names rather than generating token permutations is
 * both more effective and more defensible: we only ever ask an ATS about
 * companies we already have reason to believe exist.
 *
 * All verified live 2026-07-28. See VERIFIED-SOURCES.md.
 */

import { httpRequest, httpJson } from '../util/http.js';
import type { SourceResult } from '../../shared/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Y Combinator — 6,087 companies, 801 SF + hiring + active. One request.
// ─────────────────────────────────────────────────────────────────────────────

export interface YcCompany {
  id: number;
  name: string;
  website: string | null;
  all_locations: string | null;
  team_size: number | null;
  batch: string | null;
  industry: string | null;
  industries: string[] | null;
  subindustry: string | null;
  one_liner: string | null;
  long_description: string | null;
  status: string | null;
  isHiring: boolean | null;
  tags: string[] | null;
}

const YC_URL = 'https://yc-oss.github.io/api/companies/all.json';

export async function fetchYcCompanies(): Promise<SourceResult<YcCompany[]>> {
  const res = await httpRequest(YC_URL, { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });
  if (!res.ok) {
    return { ok: false, data: null, url: YC_URL, fetchedAt: res.fetchedAt, httpStatus: res.status, error: res.error };
  }
  try {
    const all = JSON.parse(res.body) as YcCompany[];
    return { ok: true, data: all, url: YC_URL, fetchedAt: res.fetchedAt, httpStatus: res.status };
  } catch (e) {
    return {
      ok: false,
      data: null,
      url: YC_URL,
      fetchedAt: res.fetchedAt,
      error: `parse failed: ${e instanceof Error ? e.message : e}`,
    };
  }
}

const BAY_AREA_MARKERS = [
  'san francisco', 'sf bay', 'bay area', 'oakland', 'berkeley', 'palo alto',
  'mountain view', 'menlo park', 'redwood city', 'san mateo', 'sunnyvale',
  'santa clara', 'san jose', 'cupertino', 'fremont', 'emeryville', 'burlingame',
  'south san francisco', 'foster city', 'los altos', 'campbell', 'milpitas',
  'san carlos', 'belmont', 'hayward', 'alameda', 'richmond, ca', 'novato',
  'san rafael', 'walnut creek', 'pleasanton', 'san bruno', 'daly city',
];

export function isBayArea(location: string | null | undefined): boolean {
  if (!location) return false;
  const l = location.toLowerCase();
  return BAY_AREA_MARKERS.some((m) => l.includes(m));
}

export function filterYcIcp(
  companies: YcCompany[],
  opts: { minTeam?: number; maxTeam?: number; requireHiring?: boolean } = {},
): YcCompany[] {
  const { minTeam = 3, maxTeam = 1000, requireHiring = false } = opts;
  return companies.filter((c) => {
    if (c.status !== 'Active') return false;
    if (!isBayArea(c.all_locations)) return false;
    if (requireHiring && !c.isHiring) return false;
    const size = c.team_size;
    if (size != null && (size < minTeam || size > maxTeam)) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hacker News "Ask HN: Who is hiring?"
//
// Highest-intent free source found: the July 2026 thread carried 276 postings,
// 42 mentioning SF, and 76 email addresses published inline BY THE HIRING PARTY.
// Those addresses are self-published for exactly this purpose, which makes them
// the cleanest-provenance contacts in the entire pipeline.
// ─────────────────────────────────────────────────────────────────────────────

interface HnHit {
  objectID: string;
  title: string;
  created_at: string;
  num_comments: number | null;
}

export interface HnPosting {
  commentId: string;
  threadId: string;
  threadTitle: string;
  author: string;
  createdAt: string;
  text: string;
  emails: string[];
  urls: string[];
  mentionsBayArea: boolean;
}

export async function listWhoIsHiringThreads(limit = 12): Promise<HnHit[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=${limit * 2}`;
  const data = await httpJson<{ hits: HnHit[] }>(url);
  if (!data?.hits) return [];
  return data.hits.filter((h) => /who is hiring/i.test(h.title)).slice(0, limit);
}

export async function fetchWhoIsHiringThread(threadId: string): Promise<HnPosting[]> {
  const url = `https://hn.algolia.com/api/v1/items/${threadId}`;
  const data = await httpJson<{
    id: number;
    title: string;
    children?: { id: number; author: string | null; created_at: string; text: string | null }[];
  }>(url, { timeoutMs: 45_000 });
  if (!data?.children) return [];

  return data.children
    .filter((c) => c.text)
    .map((c) => {
      const text = decodeHnText(c.text!);
      return {
        commentId: String(c.id),
        threadId,
        threadTitle: data.title,
        author: c.author ?? 'unknown',
        createdAt: c.created_at,
        text,
        emails: extractEmails(text),
        urls: extractUrls(text),
        mentionsBayArea: isBayArea(text) || /\bSF\b|\bBay Area\b/i.test(text),
      };
    });
}

function decodeHnText(html: string): string {
  return html
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .trim();
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

export function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_RE) ?? [];
  return [
    ...new Set(
      found
        .map((e) => e.toLowerCase().replace(/[.,;:)\]]+$/, ''))
        .filter((e) => !e.endsWith('.png') && !e.endsWith('.jpg')),
    ),
  ];
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:)\]]+$/, '')))];
}

// ─────────────────────────────────────────────────────────────────────────────
// Careers-page ATS resolution
//
// Recovers companies whose ATS token is not guessable from their name — measured
// examples: Paradigm -> "paradigmai", People.ai -> "people-ai",
// Sunflower -> "sunflower-sober". Worth +7pp of coverage on top of slug guessing.
// ─────────────────────────────────────────────────────────────────────────────

const ATS_LINK_PATTERNS: { platform: string; re: RegExp }[] = [
  { platform: 'greenhouse', re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i },
  { platform: 'greenhouse', re: /greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/i },
  { platform: 'ashby', re: /jobs\.ashbyhq\.com\/([a-zA-Z0-9_-]+)/ },
  { platform: 'lever', re: /jobs\.lever\.co\/([a-zA-Z0-9_-]+)/ },
  { platform: 'workable', re: /([a-z0-9-]+)\.workable\.com/i },
  { platform: 'smartrecruiters', re: /careers\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/ },
  { platform: 'workday', re: /([a-z0-9-]+)\.wd(\d)\.myworkdayjobs\.com/i },
  { platform: 'rippling', re: /ats\.rippling\.com\/([a-z0-9-]+)/i },
  { platform: 'breezy', re: /([a-z0-9-]+)\.breezy\.hr/i },
  { platform: 'recruitee', re: /([a-z0-9-]+)\.recruitee\.com/i },
  { platform: 'teamtailor', re: /([a-z0-9-]+)\.teamtailor\.com/i },
];

const RESERVED_TOKENS = new Set(['www', 'jobs', 'embed', 'api', 'app', 'careers', 'help', 'blog']);
const CAREERS_PATHS = ['/careers', '/jobs', '', '/company/careers', '/about/careers', '/careers/'];

export interface CareersProbe {
  platform: string;
  token: string;
  foundAt: string;
}

export async function resolveAtsFromCareersPage(website: string): Promise<CareersProbe | null> {
  const base = website.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return null;

  for (const path of CAREERS_PATHS) {
    const url = base + path;
    const res = await httpRequest(url, { maxRetries: 0, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
    if (res.blocked) return null;
    if (!res.ok || !res.body) continue;

    for (const { platform, re } of ATS_LINK_PATTERNS) {
      const m = res.body.match(re);
      const token = m?.[1];
      if (token && !RESERVED_TOKENS.has(token.toLowerCase())) {
        return { platform, token, foundAt: url };
      }
    }
  }
  return null;
}

/**
 * Candidate ATS tokens derived from a company's name and domain.
 *
 * Measured hit rate on YC SF startups: 37% from these alone; 62% on larger
 * well-known companies. Ordered most-likely-first so the common case resolves
 * on the first request.
 */
export function candidateTokens(name: string, website: string | null): string[] {
  const out: string[] = [];
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();

  if (base) {
    out.push(base.replace(/\s+/g, ''));
    out.push(base.replace(/\s+/g, '-'));
    // "Foo Labs" / "Foo AI" -> "foo"
    const stripped = base.replace(/\s+(ai|labs|inc|io|hq|technologies|tech|systems)$/, '').trim();
    if (stripped && stripped !== base) out.push(stripped.replace(/\s+/g, ''));
  }

  if (website) {
    const m = website.match(/https?:\/\/(?:www\.)?([^./]+)/i);
    if (m?.[1]) out.push(m[1].toLowerCase());
  }

  return [...new Set(out.filter((t) => t.length >= 2 && t.length <= 60))];
}
