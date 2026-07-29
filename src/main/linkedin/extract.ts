/**
 * LinkedIn identification extraction.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS MODULE NEVER EXTRACTS, INFERS OR STORES AN EMAIL ADDRESS OR PHONE
 * NUMBER FROM LINKEDIN. Only identification fields are read: a person's name,
 * their headline/title, their public profile URL, their current company, and
 * company-level headcount / industry / employee counts by title keyword.
 *
 * That constraint is the single highest-leverage mitigation in the design. It
 * means the worst outcome of a lost or challenged session is a failed scraping
 * run, not a contaminated contact database. Contact values come exclusively
 * from the verification module, where every value carries an evidence row.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Mechanism: all data requests are issued from INSIDE a logged-in page in the
 * `persist:linkedin` partition via `webContents.executeJavaScript`. Cookies,
 * headers, Origin/Referer and TLS fingerprint therefore all match a real
 * browser session instead of being reconstructed in Node.
 *
 * Every extraction is written as an ordered list of strategies. LinkedIn's
 * internal Voyager endpoints and DOM class names both change without notice,
 * so a single hard-coded path would be permanently broken within months. The
 * DOM strategies use only URLs a human would actually visit and parse rendered
 * text rather than class names, which is the most durable of the options.
 * When every strategy fails the functions return null — never a fabricated or
 * defaulted value.
 */

import type { Persona } from '../../shared/types.js';
import type { BrowserWindow, WebContents } from 'electron';
import {
  LINKEDIN_PARTITION,
  acquireRequestSlot,
  getCsrfToken,
  getStatus,
  haltForToday,
  isAuthWallUrl,
  isCheckpointUrl,
  sleep,
} from './session.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Identification only. There is deliberately no email or phone field here. */
export interface LinkedInPerson {
  fullName: string;
  /** Raw headline as shown; the closest thing LinkedIn gives to a title. */
  headline: string | null;
  title: string | null;
  publicProfileUrl: string | null;
  companyName: string | null;
  persona: Persona | null;
}

export interface LinkedInCompany {
  slug: string;
  companyId: string | null;
  name: string | null;
  /** Exact staff count when LinkedIn publishes one. */
  headcount: number | null;
  /** e.g. "51-200 employees" — what the About tab shows. */
  headcountRange: string | null;
  industry: string | null;
  linkedinUrl: string;
  sourceUrl: string;
  fetchedAt: string;
  rawBody: string;
}

export interface RecruiterSignal {
  slug: string;
  linkedinUrl: string;
  /** Null is impossible here — callers get null from countRecruiters() instead. */
  recruiterCount: number;
  hasInhouseTa: boolean;
  matched: LinkedInPerson[];
  /** How many distinct profiles we actually saw. */
  scanned: number;
  /** True when we hit the page cap, so recruiterCount is a lower bound. */
  truncated: boolean;
  headcount: number | null;
  headcountRange: string | null;
  industry: string | null;
  method: 'dom';
  sourceUrl: string;
  fetchedAt: string;
  rawBody: string;
}

export interface TitleKeywordCount {
  keyword: string;
  count: number;
  people: LinkedInPerson[];
}

/**
 * The classifier the scoring engine's highest-signal input depends on.
 * `people op` rather than `people ops` so it also catches the spelled-out
 * "People Operations", which is the same function under a longer name.
 */
const RECRUITER_WORDS = /recruit|talent|sourcer|people op/i;
/** Case-sensitive so it matches the acronym and not the syllable in "data". */
const TA_ACRONYM = /\bTA\b/;

export function matchesRecruiterTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return RECRUITER_WORDS.test(title) || TA_ACRONYM.test(title);
}

const RECRUITER_QUERY = 'recruiter OR "talent acquisition" OR sourcer OR "people operations"';
const LEADERSHIP_QUERY = 'founder OR CEO OR CTO OR "VP Engineering" OR "Head of Engineering"';
const TALENT_LEAD_QUERY = '"Head of Talent" OR "Head of People" OR "Director of Recruiting"';

const MAX_PROFILES_PER_PAGE = 60;
const RAW_BODY_CAP = 200_000;
const SPA_SETTLE_TIMEOUT_MS = 18_000;

/** Current SPA settle budget; only tests ever change it (see the seam below). */
let spaSettleTimeoutMs = SPA_SETTLE_TIMEOUT_MS;

/**
 * Test seam. The settle poll spends up to 18 real seconds waiting for people
 * cards, which is right for a live SPA and wrong for a unit test proving what
 * happens when they never appear. Production never calls this.
 */
export function __setSpaSettleTimeoutForTests(ms: number | null): void {
  spaSettleTimeoutMs = ms ?? SPA_SETTLE_TIMEOUT_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker window — hidden, on the same persistent partition as the login window
// ─────────────────────────────────────────────────────────────────────────────

type ElectronNs = typeof import('electron');
let electronNs: ElectronNs | null | undefined;

async function electron(): Promise<ElectronNs | null> {
  if (electronNs !== undefined) return electronNs;
  try {
    // require, not a native dynamic import — see the twin helper in session.ts
    // for why: the CJS require is the seam the test electron stub patches, and
    // it is what every real runtime of this bundle provides anyway.
    const ns = (
      typeof require === 'function' ? require('electron') : await import('electron')
    ) as unknown as ElectronNs;
    electronNs = ns && typeof ns.BrowserWindow === 'function' ? ns : null;
  } catch {
    electronNs = null;
  }
  return electronNs;
}

let workerWindow: BrowserWindow | null = null;

async function getWorkerWindow(): Promise<BrowserWindow | null> {
  const e = await electron();
  if (!e) return null;
  if (!e.app.isReady()) await e.app.whenReady();

  if (workerWindow && !workerWindow.isDestroyed()) return workerWindow;

  workerWindow = new e.BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      partition: LINKEDIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden window is throttled to ~1fps otherwise, which stalls the SPA
      // long enough that people cards never render.
      backgroundThrottling: false,
    },
  });
  // A hidden worker window has no business spawning visible popups; anything
  // LinkedIn tries to open is denied rather than shown to the operator.
  workerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  workerWindow.on('closed', () => {
    workerWindow = null;
  });
  return workerWindow;
}

/**
 * Whether a URL is on LinkedIn at all.
 *
 * Everything this module injects into a page — the CSRF token above all — is
 * only safe because the page is LinkedIn's. A redirect that lands the worker
 * window somewhere else is not a checkpoint and not an auth wall, so neither
 * of the two guards below catches it, and the next `executeJavaScript` would
 * hand the session's `csrf-token` header to whatever page is now loaded.
 */
export function isLinkedInUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

export function closeWorkerWindow(): void {
  if (workerWindow && !workerWindow.isDestroyed()) workerWindow.close();
  workerWindow = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation + in-page fetch
// ─────────────────────────────────────────────────────────────────────────────

type AnyListener = (...args: unknown[]) => void;
interface Emitterish {
  on(event: string, fn: AnyListener): void;
  removeListener(event: string, fn: AnyListener): void;
}

interface NavResult {
  ok: boolean;
  url: string;
  status: number;
  error?: string;
}

async function navigateTo(wc: WebContents, url: string): Promise<NavResult> {
  let status = 0;
  const emitter = wc as unknown as Emitterish;
  const onNavigate: AnyListener = (...args) => {
    const code = args[2];
    if (typeof code === 'number' && code > 0) status = code;
  };
  emitter.on('did-navigate', onNavigate);

  let error: string | undefined;
  try {
    await wc.loadURL(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ERR_ABORTED is what a client-side redirect looks like from loadURL; the
    // final URL below is authoritative, so it is not an error on its own.
    if (!/ERR_ABORTED/i.test(msg)) error = msg;
  } finally {
    emitter.removeListener('did-navigate', onNavigate);
  }

  const finalUrl = wc.getURL();

  if (status === 999 || status === 429 || status === 403) {
    await haltForToday(`LinkedIn returned ${status} on ${url}`, 'blocked');
    return { ok: false, url: finalUrl, status, error: `HTTP ${status}` };
  }
  if (isCheckpointUrl(finalUrl) && !isAuthWallUrl(finalUrl)) {
    await haltForToday('LinkedIn security checkpoint', 'checkpoint');
    return { ok: false, url: finalUrl, status, error: 'checkpoint' };
  }
  if (isAuthWallUrl(finalUrl)) {
    await haltForToday('LinkedIn showed an auth wall — the session is no longer valid', 'auth');
    return { ok: false, url: finalUrl, status, error: 'authwall' };
  }
  if (error) return { ok: false, url: finalUrl, status, error };
  // An empty final URL means the load never committed; `error` above already
  // describes that case. A committed URL off LinkedIn is a redirect we will
  // not run scripts against.
  if (finalUrl && !isLinkedInUrl(finalUrl)) {
    return { ok: false, url: finalUrl, status, error: 'redirected off linkedin.com' };
  }

  return { ok: true, url: finalUrl, status };
}

interface PageFetchResult {
  status: number;
  url: string;
  body: string;
  error?: string;
}

/**
 * Runs the request in the page, not in Node. Voyager rejects anything whose
 * headers, cookies or TLS fingerprint do not look like the browser that holds
 * the session, and reproducing all three from Node is both fragile and
 * exactly the kind of impersonation we do not want to build.
 */
async function pageFetch(wc: WebContents, url: string, csrf: string): Promise<PageFetchResult | null> {
  // The token below is only ever handed to LinkedIn's own origin.
  const loaded = wc.getURL();
  if (!isLinkedInUrl(loaded)) {
    return { status: 0, url: loaded, body: '', error: 'not on a linkedin.com page' };
  }

  const script = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'csrf-token': ${JSON.stringify(csrf)},
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US'
        }
      });
      const text = await res.text();
      return { status: res.status, url: res.url, body: text.slice(0, 2000000) };
    } catch (err) {
      return { status: 0, url: ${JSON.stringify(url)}, body: '', error: String(err) };
    }
  })()`;

  let result: PageFetchResult;
  try {
    result = (await wc.executeJavaScript(script, true)) as PageFetchResult;
  } catch (err) {
    return { status: 0, url, body: '', error: err instanceof Error ? err.message : String(err) };
  }
  if (!result) return null;

  if (result.status === 999 || result.status === 429 || result.status === 403) {
    await haltForToday(`LinkedIn returned ${result.status} on a data request`, 'blocked');
    return null;
  }
  if (isCheckpointUrl(result.url) && !isAuthWallUrl(result.url)) {
    await haltForToday('LinkedIn security checkpoint', 'checkpoint');
    return null;
  }
  if (result.status === 401 || isAuthWallUrl(result.url)) {
    await haltForToday('LinkedIn session rejected the request — sign in again', 'auth');
    return null;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-page DOM harvesting
// ─────────────────────────────────────────────────────────────────────────────

interface DomHarvest {
  people: { id: string; href: string; text: string }[];
  bodyText: string;
  url: string;
  title: string;
  empty: boolean;
}

/**
 * Deliberately class-name-free. Anchors to /in/<slug> are the one structural
 * feature of a LinkedIn people listing that cannot change without changing the
 * product, so the extractor keys off those and reads the surrounding rendered
 * text rather than any styling hook.
 */
const HARVEST_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/in/"]');
  for (const a of anchors) {
    const href = a.href || '';
    const m = href.match(/linkedin\\.com\\/in\\/([^\\/?#]+)/);
    if (!m) continue;
    let id = '';
    try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let node = a;
    let card = null;
    for (let i = 0; i < 6 && node; i++) {
      const cls = node.className ? String(node.className) : '';
      if (node.tagName === 'LI' || /profile-card|entity-result|people|search-result/i.test(cls)) { card = node; break; }
      node = node.parentElement;
    }
    const host = card || a.parentElement || a;
    const text = (host.innerText || a.innerText || '').slice(0, 500);
    out.push({ id: id, href: href.split('?')[0], text: text });
  }
  const bodyText = (document.body ? document.body.innerText || '' : '').slice(0, 6000);
  const empty = /no results|nothing to see|couldn't find|didn't match/i.test(bodyText);
  return { people: out, bodyText: bodyText, url: location.href, title: document.title, empty: empty };
})()`;

async function harvestDom(wc: WebContents): Promise<DomHarvest | null> {
  try {
    return (await wc.executeJavaScript(HARVEST_SCRIPT, true)) as DomHarvest;
  } catch {
    return null;
  }
}

/**
 * The people tab is a client-rendered SPA, so did-finish-load fires long before
 * any card exists. Poll until profiles appear, an explicit empty state appears,
 * or the budget of patience runs out.
 */
async function waitForPeople(wc: WebContents): Promise<DomHarvest | null> {
  const deadline = Date.now() + spaSettleTimeoutMs;
  let last: DomHarvest | null = null;
  while (Date.now() < deadline) {
    last = await harvestDom(wc);
    if (last && (last.people.length > 0 || last.empty)) return last;
    await sleep(900);
  }
  return last;
}

/** Two lazy-load passes. Costs no budget — it is the same page we already paid for. */
async function scrollForMore(wc: WebContents): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try {
      await wc.executeJavaScript('window.scrollTo(0, document.body.scrollHeight); true', true);
    } catch {
      return;
    }
    await sleep(1400);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

const NOISE_LINE =
  /^(view |message$|connect$|follow$|following$|status is|• |·|\d+(st|nd|rd|th)\b|premium|open to work)/i;
const DEGREE_SUFFIX = /[,·•]?\s*\b\d(?:st|nd|rd|th)\+?\b.*$/i;

function cleanName(raw: string): string {
  return raw
    .replace(/^view\s+/i, '')
    .replace(/[’']s profile$/i, '')
    .replace(DEGREE_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCardText(text: string): { fullName: string; headline: string | null } | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let name = '';
  let idx = 0;
  for (; idx < lines.length; idx++) {
    const candidate = cleanName(lines[idx]!);
    if (candidate && candidate.length <= 80 && !NOISE_LINE.test(candidate)) {
      name = candidate;
      break;
    }
  }
  if (!name) return null;

  let headline: string | null = null;
  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j]!.replace(DEGREE_SUFFIX, '').trim();
    if (!line || line === name || NOISE_LINE.test(line)) continue;
    headline = line.slice(0, 200);
    break;
  }
  return { fullName: name, headline };
}

function personFromCard(
  card: { id: string; href: string; text: string },
  companyName: string | null,
): LinkedInPerson | null {
  const parsed = parseCardText(card.text);
  const fullName = parsed?.fullName ?? prettifySlug(card.id);
  if (!fullName) return null;
  const headline = parsed?.headline ?? null;
  return {
    fullName,
    headline,
    title: headline,
    publicProfileUrl: `https://www.linkedin.com/in/${card.id}`,
    companyName,
    persona: personaFromTitle(headline),
  };
}

function prettifySlug(slug: string): string {
  const bare = slug.replace(/-[0-9a-f]{4,}$/i, '').replace(/-\d+$/, '');
  return bare
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim();
}

/** Maps a raw headline to the buyer persona the scoring engine uses. */
export function personaFromTitle(title: string | null): Persona | null {
  if (!title) return null;
  const t = title.toLowerCase();

  if (/\b(co-?founder|founder|ceo|chief executive)\b/.test(t)) return 'founder_ceo';
  if (
    /\bhead of (talent|people|recruiting|recruitment|ta)\b/.test(t) ||
    /\b(vp|vice president|director|chief) (of )?(talent|people|recruiting|recruitment|hr)\b/.test(t) ||
    /\bchief people officer\b/.test(t) ||
    /\btalent (lead|leader|partner lead)\b/.test(t)
  ) {
    return 'head_of_talent';
  }
  if (
    /\b(cto|chief technology|chief technical)\b/.test(t) ||
    /\b(vp|vice president|svp|head|director) (of )?(engineering|technology|eng)\b/.test(t) ||
    /\bvp,? eng\b/.test(t)
  ) {
    return 'cto_vpe';
  }
  if (
    /\b(recruiter|recruiting|recruitment|sourcer|talent acquisition|talent partner|people operations|people ops)\b/.test(
      t,
    ) ||
    TA_ACRONYM.test(title)
  ) {
    return 'recruiter';
  }
  if (/\b(coo|chief operating|chief of staff|head of operations|vp of operations)\b/.test(t)) {
    return 'coo_ops';
  }
  if (/\b(engineering manager|hiring manager|head of product|director of|manager,)\b/.test(t)) {
    return 'hiring_manager';
  }
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Voyager JSON harvesting
// ─────────────────────────────────────────────────────────────────────────────

type Json = unknown;

function walkJson(root: Json, visit: (node: Record<string, Json>) => void, maxNodes = 60_000): void {
  const stack: Json[] = [root];
  let seen = 0;
  while (stack.length && seen < maxNodes) {
    const node = stack.pop();
    seen++;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node && typeof node === 'object') {
      const obj = node as Record<string, Json>;
      visit(obj);
      for (const key of Object.keys(obj)) stack.push(obj[key]);
    }
  }
}

function str(v: Json): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const text = (v as Record<string, Json>).text;
    if (typeof text === 'string') return text.trim() || null;
  }
  return null;
}

function harvestNumber(json: Json, keys: string[]): number | null {
  let found: number | null = null;
  walkJson(json, (obj) => {
    if (found != null) return;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        found = v;
        return;
      }
    }
  });
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Accepts a full URL, a bare slug, or anything in between. */
export function companySlug(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const m = trimmed.match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]!).toLowerCase();
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed) && !trimmed.includes(' ')) return trimmed.toLowerCase();
  return null;
}

function peopleTabUrl(slug: string, keywords?: string): string {
  const base = `https://www.linkedin.com/company/${encodeURIComponent(slug)}/people/`;
  return keywords ? `${base}?keywords=${encodeURIComponent(keywords)}` : base;
}

function aboutTabUrl(slug: string): string {
  return `https://www.linkedin.com/company/${encodeURIComponent(slug)}/about/`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Company-level facts
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_RE = /\b(\d[\d,]*(?:\s*[-–]\s*[\d,]+|\+))\s*employees\b/i;
const MEMBERS_RE = /\b([\d,]+)\s*associated members\b/i;
const EMPLOYEES_RE = /\b([\d,]+)\s*employees\b/i;
const INDUSTRY_RE = /\bIndustr(?:y|ies)\s*\n\s*([^\n]{2,80})/i;
const SIZE_RE = /\bCompany size\s*\n\s*([^\n]{2,60})/i;

function parseHeadcountText(text: string): { headcount: number | null; range: string | null } {
  const sizeBlock = text.match(SIZE_RE)?.[1] ?? '';
  const rangeHit = (sizeBlock.match(RANGE_RE) ?? text.match(RANGE_RE))?.[1] ?? null;

  // "11-50 employees" also matches the bare-number pattern on its upper bound,
  // so an exact count is only trusted when it is not part of a band.
  const memberHit = text.match(MEMBERS_RE)?.[1] ?? null;
  const exactHit = memberHit ?? (rangeHit ? null : text.match(EMPLOYEES_RE)?.[1] ?? null);

  let headcount: number | null = null;
  if (exactHit) {
    const n = Number(exactHit.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 5_000_000) headcount = n;
  }
  return { headcount, range: rangeHit ? `${rangeHit} employees` : null };
}

function parseIndustry(text: string): string | null {
  const m = text.match(INDUSTRY_RE);
  if (!m) return null;
  const value = m[1]!.trim();
  return value && value.length <= 80 ? value : null;
}

/**
 * Company headcount range + industry. Costs one budget unit.
 * Returns null whenever the module is unavailable — callers must tolerate that.
 */
export async function getCompanyProfile(companyUrl: string): Promise<LinkedInCompany | null> {
  const slug = companySlug(companyUrl);
  if (!slug) return null;

  const slot = await acquireRequestSlot(1);
  if (!slot.ok) return null;

  const win = await getWorkerWindow();
  if (!win) return null;
  const wc = win.webContents;

  const url = aboutTabUrl(slug);
  const nav = await navigateTo(wc, url);
  if (!nav.ok) return null;

  await sleep(1200);
  const dom = await harvestDom(wc);
  const bodyText = dom?.bodyText ?? '';

  const { headcount, range } = parseHeadcountText(bodyText);
  let industry = parseIndustry(bodyText);
  let companyId: string | null = null;
  let name = dom?.title ? dom.title.replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(/\s*\|\s*About\s*$/i, '').trim() : null;
  let voyagerRaw = '';

  // Voyager is tried second and only to fill gaps — the rendered About tab is
  // both cheaper and far more stable than the internal API surface.
  if (headcount == null || !industry) {
    const csrf = await getCsrfToken();
    if (csrf) {
      const slot2 = await acquireRequestSlot(1);
      if (slot2.ok) {
        const apiUrl =
          'https://www.linkedin.com/voyager/api/organization/companies' +
          '?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12' +
          `&q=universalName&universalName=${encodeURIComponent(slug)}`;
        const res = await pageFetch(wc, apiUrl, csrf);
        if (res && res.status >= 200 && res.status < 300 && res.body) {
          voyagerRaw = res.body.slice(0, RAW_BODY_CAP);
          try {
            const json = JSON.parse(res.body) as Json;
            const staff = harvestNumber(json, ['staffCount']);
            walkJson(json, (obj) => {
              if (!companyId && typeof obj.entityUrn === 'string') {
                const m = obj.entityUrn.match(/urn:li:(?:fs_normalized_company|company|fsd_company):(\d+)/);
                if (m) companyId = m[1]!;
              }
              if (!name) {
                const n = str(obj.localizedName) ?? (typeof obj.name === 'string' ? obj.name : null);
                if (n && typeof obj.entityUrn === 'string' && /company/i.test(obj.entityUrn)) name = n;
              }
              if (!industry && Array.isArray(obj.companyIndustries)) {
                for (const ind of obj.companyIndustries as Json[]) {
                  const v = str((ind as Record<string, Json>)?.localizedName);
                  if (v) {
                    industry = v;
                    break;
                  }
                }
              }
            });
            if (staff != null && staff > 0) {
              return {
                slug,
                companyId,
                name,
                headcount: staff,
                headcountRange: range,
                industry,
                linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
                sourceUrl: url,
                fetchedAt: new Date().toISOString(),
                rawBody: (bodyText + '\n\n' + voyagerRaw).slice(0, RAW_BODY_CAP),
              };
            }
          } catch {
            /* unparseable — the DOM values below still stand */
          }
        }
      }
    }
  }

  if (headcount == null && range == null && !industry) return null;

  return {
    slug,
    companyId,
    name,
    headcount,
    headcountRange: range,
    industry,
    linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    rawBody: (bodyText + (voyagerRaw ? '\n\n' + voyagerRaw : '')).slice(0, RAW_BODY_CAP),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// People queries
// ─────────────────────────────────────────────────────────────────────────────

interface PeopleResult {
  people: LinkedInPerson[];
  method: 'dom';
  sourceUrl: string;
  bodyText: string;
  rawBody: string;
  truncated: boolean;
}

/**
 * One paid navigation to the company's People tab with a keyword filter, then
 * a free DOM harvest of that page. There is deliberately no search fallback:
 * the People tab is the only surface whose results are actually scoped to the
 * company, so when its harvest fails the only honest outcome is inconclusive
 * (null) — never a broader query whose hits would be misattributed here.
 */
async function peopleAtCompany(slug: string, keywords: string): Promise<PeopleResult | null> {
  const slot = await acquireRequestSlot(1);
  if (!slot.ok) return null;

  const win = await getWorkerWindow();
  if (!win) return null;
  const wc = win.webContents;

  const url = peopleTabUrl(slug, keywords);
  const nav = await navigateTo(wc, url);
  if (!nav.ok) return null;

  const settled = await waitForPeople(wc);
  if (settled && settled.people.length > 0) {
    await scrollForMore(wc);
    const full = (await harvestDom(wc)) ?? settled;
    const cards = full.people.slice(0, MAX_PROFILES_PER_PAGE);
    const people = cards
      .map((c) => personFromCard(c, null))
      .filter((p): p is LinkedInPerson => p != null);
    if (people.length > 0) {
      return {
        people,
        method: 'dom',
        sourceUrl: url,
        bodyText: full.bodyText,
        rawBody: JSON.stringify({ url: full.url, people: cards }).slice(0, RAW_BODY_CAP),
        truncated: full.people.length >= MAX_PROFILES_PER_PAGE,
      };
    }
  }

  // An explicit "no results" state is a real answer, not a failure — but it is
  // an answer about the keyword filter, so the caller still treats an empty
  // people list as inconclusive rather than as a confirmed zero.
  if (settled?.empty) {
    return {
      people: [],
      method: 'dom',
      sourceUrl: url,
      bodyText: settled.bodyText,
      rawBody: JSON.stringify({ url: settled.url, empty: true }).slice(0, RAW_BODY_CAP),
      truncated: false,
    };
  }

  // There used to be a Voyager blended-search fallback here for the case where
  // the People tab rendered but no cards could be harvested. It is gone on
  // purpose: that endpoint took only the keyword query, with no company facet,
  // so its results were GLOBAL matches — strangers who merely have "recruiter"
  // in their headline — silently attributed to this company. countRecruiters()
  // would then report in-house TA that does not exist, and findDecisionMakers()
  // would store unrelated people as this company's contacts. A fallback that
  // broadens scope does not degrade gracefully, it fabricates. Adding a company
  // facet is not a fix either: Voyager's facet syntax is unversioned and cannot
  // be verified from here, and a silently wrong facet is this same bug again.
  // When the DOM harvest fails, the answer the module header promises is the
  // right one — inconclusive, so null.
  return null;
}

/**
 * Counts employees whose title matches the recruiter pattern.
 *
 * Returns null on ANY inconclusive outcome. This matters: src/shared/score.ts
 * `scoreAgencyFit` checks `recruiters === 0 || hasInhouseTa === false` FIRST and
 * awards the full 15 points for it, so writing a 0 we are not sure about would
 * silently promote every company a failed scrape touched. Null is scored at 7
 * of 15 with the reason "in-house TA unknown" — the correct neutral outcome.
 */
export async function countRecruiters(companyLinkedInUrl: string): Promise<RecruiterSignal | null> {
  const slug = companySlug(companyLinkedInUrl);
  if (!slug) return null;
  if (!(await getStatus()).available) return null;

  const result = await peopleAtCompany(slug, RECRUITER_QUERY);
  if (!result) return null;

  // Zero profiles means the filter, the rendering or the session changed — not
  // that the company has no recruiters. Refuse to answer.
  if (result.people.length === 0) return null;

  const matched = result.people.filter((p) => matchesRecruiterTitle(p.title ?? p.headline));
  const { headcount, range } = parseHeadcountText(result.bodyText);

  return {
    slug,
    linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
    recruiterCount: matched.length,
    hasInhouseTa: matched.length > 0,
    matched,
    scanned: result.people.length,
    truncated: result.truncated,
    headcount,
    headcountRange: range,
    industry: parseIndustry(result.bodyText),
    method: result.method,
    sourceUrl: result.sourceUrl,
    fetchedAt: new Date().toISOString(),
    rawBody: result.rawBody,
  };
}

/**
 * Employee counts by arbitrary title keyword. One budget unit per keyword, so
 * callers should pass a short list.
 */
export async function countByTitleKeywords(
  companyLinkedInUrl: string,
  keywords: string[],
): Promise<TitleKeywordCount[] | null> {
  const slug = companySlug(companyLinkedInUrl);
  if (!slug) return null;

  const out: TitleKeywordCount[] = [];
  for (const keyword of keywords) {
    if (!(await getStatus()).available) break;
    const result = await peopleAtCompany(slug, keyword);
    if (!result) break;
    const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const people = result.people.filter((p) => re.test(p.title ?? p.headline ?? ''));
    out.push({ keyword, count: people.length, people });
  }
  return out.length > 0 ? out : null;
}

/**
 * People whose titles map to a founder / CTO / VP Eng / Head of Talent persona.
 * Two keyword passes, so two budget units. Identification fields only — the
 * email for any of these people is produced by the verification module, never
 * here.
 */
export async function findDecisionMakers(companyLinkedInUrl: string): Promise<LinkedInPerson[] | null> {
  const slug = companySlug(companyLinkedInUrl);
  if (!slug) return null;
  if (!(await getStatus()).available) return null;

  const wanted = new Set<Persona>(['founder_ceo', 'cto_vpe', 'head_of_talent']);
  const byProfile = new Map<string, LinkedInPerson>();
  let anySucceeded = false;

  for (const query of [LEADERSHIP_QUERY, TALENT_LEAD_QUERY]) {
    if (!(await getStatus()).available) break;
    const result = await peopleAtCompany(slug, query);
    if (!result) break;
    anySucceeded = true;
    for (const person of result.people) {
      if (!person.persona || !wanted.has(person.persona)) continue;
      const key = person.publicProfileUrl ?? person.fullName.toLowerCase();
      const existing = byProfile.get(key);
      if (!existing || (!existing.headline && person.headline)) byProfile.set(key, person);
    }
  }

  if (!anySucceeded) return null;

  const rank: Record<string, number> = { founder_ceo: 0, cto_vpe: 1, head_of_talent: 2 };
  return [...byProfile.values()].sort(
    (a, b) => (rank[a.persona ?? ''] ?? 9) - (rank[b.persona ?? ''] ?? 9),
  );
}
