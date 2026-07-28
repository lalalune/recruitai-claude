/**
 * LinkedIn session, budget and safety gate.
 *
 * Mechanism: an Electron BrowserWindow bound to the persistent partition
 * `persist:linkedin`. Electron already ships Chromium, so this needs no
 * Playwright dependency, no bundled-browser packaging problem, and no
 * separate cookie store — the partition is durable across restarts.
 *
 * The app never sees or types the operator's password. `openLoginWindow()`
 * shows a real, visible LinkedIn login page and waits for the `li_at` cookie
 * to appear in the partition's jar. Two-factor, e-mail challenges and any
 * CAPTCHA are handled by the operator in that window.
 *
 * Everything downstream of here is gated by three independent brakes:
 *   1. a hard daily budget, persisted per calendar day in the `setting` table
 *      so a restart cannot reset it;
 *   2. a randomised 8-25s spacing between requests, also persisted;
 *   3. a day-long hard stop triggered by any sign of trouble (429, 999,
 *      /checkpoint/, an auth wall). There is no retry path around a stop.
 */

import { getDb, get, run, type Db } from '../db/index.js';
import type { BrowserWindow, Session } from 'electron';


export const LINKEDIN_PARTITION = 'persist:linkedin';
export const LOGIN_URL = 'https://www.linkedin.com/login';
export const FEED_URL = 'https://www.linkedin.com/feed/';

/** Spacing between any two network operations this module performs. */
const REQUEST_GAP_MIN_MS = 8_000;
const REQUEST_GAP_MAX_MS = 25_000;

const DEFAULT_PER_DAY = 40;
const MAX_PER_DAY = 200;
const DEFAULT_WINDOW_START = '08:00';
const DEFAULT_WINDOW_END = '20:00';

const BUDGET_KEY_PREFIX = 'linkedin.budget.';
const HALT_KEY = 'linkedin.halt';
const BUDGET_RETENTION_DAYS = 14;

export type LinkedInState =
  | 'ready'
  | 'disabled'
  | 'unsupported'
  | 'logged_out'
  | 'checkpoint'
  | 'blocked'
  | 'budget_exhausted'
  | 'outside_window';

/** Serialisable status the UI renders. */
export interface LinkedInStatus {
  state: LinkedInState;
  available: boolean;
  enabled: boolean;
  loggedIn: boolean;
  message: string;
  /** True when only the operator can clear the condition (login, checkpoint). */
  needsOperator: boolean;
  day: string;
  budgetPerDay: number;
  budgetUsed: number;
  budgetRemaining: number;
  /** Epoch ms; the spacing gate will not release a request before this. */
  nextRequestNotBefore: number | null;
  haltReason: string | null;
  haltAt: number | null;
  windowStart: string;
  windowEnd: string;
  inWindow: boolean;
}

export interface SlotResult {
  ok: boolean;
  reason: string;
  status: LinkedInStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron access, resolved lazily so importing this file from a plain Node
// context (the pipeline worker) degrades to "unsupported" instead of throwing.
// ─────────────────────────────────────────────────────────────────────────────

type ElectronNs = typeof import('electron');
let electronNs: ElectronNs | null | undefined;

async function electron(): Promise<ElectronNs | null> {
  if (electronNs !== undefined) return electronNs;
  try {
    const ns = (await import('electron')) as unknown as ElectronNs;
    electronNs = ns && typeof ns.BrowserWindow === 'function' ? ns : null;
  } catch {
    electronNs = null;
  }
  return electronNs;
}

let guardsInstalled = false;
/** Suppresses the trouble guard while the operator is deliberately in a login/2FA flow. */
let loginInProgress = false;

export async function getPartitionSession(): Promise<Session | null> {
  const e = await electron();
  if (!e) return null;
  if (!e.app.isReady()) await e.app.whenReady();
  const ses = e.session.fromPartition(LINKEDIN_PARTITION);
  installGuards(ses);
  return ses;
}

/**
 * Passive watchdog on the partition. A 999 or 429 anywhere in this partition,
 * or a redirect into /checkpoint/, stops the module for the rest of the day.
 * Observational only — it never modifies or blocks a request.
 */
function installGuards(ses: Session): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  const filter = { urls: ['*://*.linkedin.com/*'] };

  ses.webRequest.onCompleted(filter, (details) => {
    if (loginInProgress) return;
    const status = details.statusCode;
    if (status === 999) {
      void haltForToday('LinkedIn returned 999 (automation detected)', 'blocked');
    } else if (status === 429) {
      void haltForToday('LinkedIn returned 429 (rate limited)', 'blocked');
    } else if (status === 403) {
      void haltForToday('LinkedIn returned 403 (forbidden)', 'blocked');
    } else if (isCheckpointUrl(details.url)) {
      void haltForToday('LinkedIn security checkpoint', 'checkpoint');
    }
  });

  ses.webRequest.onBeforeRedirect(filter, (details) => {
    if (loginInProgress) return;
    if (isCheckpointUrl(details.redirectURL)) {
      void haltForToday('LinkedIn security checkpoint', 'checkpoint');
    }
  });
}

export function isCheckpointUrl(url: string): boolean {
  return /linkedin\.com\/(checkpoint|uas\/login|authwall)/i.test(url) || /\/checkpoint\//i.test(url);
}

export function isAuthWallUrl(url: string): boolean {
  return /linkedin\.com\/(authwall|login|uas\/login)/i.test(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookies
// ─────────────────────────────────────────────────────────────────────────────

async function readCookie(name: string): Promise<string | null> {
  const ses = await getPartitionSession();
  if (!ses) return null;
  try {
    const cookies = await ses.cookies.get({ url: 'https://www.linkedin.com', name });
    const now = Date.now() / 1000;
    for (const c of cookies) {
      if (!c.value) continue;
      // session cookies have no expirationDate and are valid while stored
      if (c.expirationDate != null && c.expirationDate <= now) continue;
      return c.value;
    }
  } catch {
    /* partition unreadable — treat as logged out */
  }
  return null;
}

export async function isLoggedIn(): Promise<boolean> {
  return (await readCookie('li_at')) != null;
}

/**
 * Voyager rejects any request without a `csrf-token` header equal to the
 * JSESSIONID cookie value with its surrounding double quotes stripped.
 */
export async function getCsrfToken(): Promise<string | null> {
  const raw = await readCookie('JSESSIONID');
  if (!raw) return null;
  const token = raw.replace(/^"+|"+$/g, '').trim();
  return token || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────

let loginWindow: BrowserWindow | null = null;

export interface LoginResult {
  loggedIn: boolean;
  message: string;
}

/**
 * Opens a real, visible LinkedIn login window and resolves once the partition
 * holds an `li_at` cookie. The operator types their own credentials; this
 * process never receives them.
 */
export async function openLoginWindow(opts: { timeoutMs?: number } = {}): Promise<LoginResult> {
  const e = await electron();
  if (!e) return { loggedIn: false, message: 'LinkedIn window unavailable outside the Electron main process.' };
  if (!e.app.isReady()) await e.app.whenReady();
  await getPartitionSession();

  if (await isLoggedIn()) {
    await clearHalt();
    return { loggedIn: true, message: 'Already signed in.' };
  }

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
  } else {
    loginWindow = new e.BrowserWindow({
      width: 1040,
      height: 860,
      show: true,
      title: 'Sign in to LinkedIn',
      autoHideMenuBar: true,
      webPreferences: {
        partition: LINKEDIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    loginWindow.on('closed', () => {
      loginWindow = null;
    });
  }

  const win = loginWindow;
  loginInProgress = true;
  try {
    try {
      await win.loadURL(LOGIN_URL);
    } catch {
      /* client-side redirects abort the load; the poll below is authoritative */
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) {
        return {
          loggedIn: await isLoggedIn(),
          message: (await isLoggedIn()) ? 'Signed in.' : 'Window closed before sign-in completed.',
        };
      }
      if (await isLoggedIn()) {
        await clearHalt();
        void emitStatus();
        if (!win.isDestroyed()) win.close();
        return { loggedIn: true, message: 'Signed in to LinkedIn.' };
      }
      await sleep(1500);
    }
    return { loggedIn: false, message: 'Timed out waiting for sign-in.' };
  } finally {
    loginInProgress = false;
  }
}

/**
 * Brings a visible window to the front on the offending URL so the operator can
 * resolve a checkpoint themselves. This module never attempts to solve one.
 */
export async function showCheckpointWindow(url = FEED_URL): Promise<void> {
  const e = await electron();
  if (!e) return;
  if (!e.app.isReady()) await e.app.whenReady();

  loginInProgress = true;
  try {
    if (!loginWindow || loginWindow.isDestroyed()) {
      loginWindow = new e.BrowserWindow({
        width: 1040,
        height: 860,
        show: true,
        title: 'LinkedIn needs your attention',
        autoHideMenuBar: true,
        webPreferences: {
          partition: LINKEDIN_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      loginWindow.on('closed', () => {
        loginWindow = null;
      });
    }
    loginWindow.show();
    loginWindow.focus();
    try {
      await loginWindow.loadURL(url);
    } catch {
      /* ignore aborted navigation */
    }
  } finally {
    // Give the operator a generous window to work through the challenge before
    // the watchdog is armed again.
    setTimeout(() => {
      loginInProgress = false;
    }, 5 * 60_000);
  }
}

export async function logout(): Promise<void> {
  const ses = await getPartitionSession();
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  loginWindow = null;
  if (ses) {
    try {
      await ses.clearStorageData();
    } catch {
      /* best effort */
    }
    try {
      await ses.clearCache();
    } catch {
      /* best effort */
    }
  }
  await clearHalt();
  void emitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings (read defensively — the settings module owns the write side)
// ─────────────────────────────────────────────────────────────────────────────

function db(): Db | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function settingRaw(key: string): string | null {
  const d = db();
  if (!d) return null;
  try {
    return get<{ value: string }>(d, 'SELECT value FROM setting WHERE key = ?', key)?.value ?? null;
  } catch {
    return null;
  }
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[[{"]|^-?\d|^true$|^false$|^null$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to the raw string */
    }
  }
  return raw;
}

function dig(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Resolves e.g. `crawl.linkedinPerDay` whether the settings layer stored it as
 * a flat key, a per-section JSON blob, or one whole-settings blob.
 */
function readSetting(path: string): unknown {
  const direct = settingRaw(path);
  if (direct != null) return parseMaybeJson(direct);

  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const raw = settingRaw(parts.slice(0, i).join('.'));
    if (raw == null) continue;
    const found = dig(parseMaybeJson(raw), parts.slice(i));
    if (found !== undefined) return found;
  }

  const blob = settingRaw('settings');
  if (blob != null) {
    const found = dig(parseMaybeJson(blob), parts);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readNumber(path: string, fallback: number, lo: number, hi: number): number {
  const v = readSetting(path);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function readBoolean(path: string, fallback: boolean): boolean {
  const v = readSetting(path);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return fallback;
}

function readTime(path: string, fallback: string): string {
  const v = readSetting(path);
  return typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : fallback;
}

export function getPerDayBudget(): number {
  return readNumber('crawl.linkedinPerDay', DEFAULT_PER_DAY, 0, MAX_PER_DAY);
}

/** Off unless the operator explicitly enables it — matches the Pipeline default. */
export function isEnabled(): boolean {
  return readBoolean('crawl.linkedinEnabled', false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget — a token bucket persisted per calendar day, so restarts cannot reset it
// ─────────────────────────────────────────────────────────────────────────────

interface BudgetRecord {
  used: number;
  lastRequestAt: number;
}

export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function budgetKey(day = localDay()): string {
  return BUDGET_KEY_PREFIX + day;
}

function readBudget(day = localDay()): BudgetRecord {
  const raw = settingRaw(budgetKey(day));
  if (!raw) return { used: 0, lastRequestAt: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<BudgetRecord>;
    return {
      used: Number.isFinite(parsed.used) ? Math.max(0, Number(parsed.used)) : 0,
      lastRequestAt: Number.isFinite(parsed.lastRequestAt) ? Number(parsed.lastRequestAt) : 0,
    };
  } catch {
    return { used: 0, lastRequestAt: 0 };
  }
}

function writeBudget(rec: BudgetRecord, day = localDay()): void {
  const d = db();
  if (!d) return;
  try {
    run(
      d,
      `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      budgetKey(day),
      JSON.stringify(rec),
      Date.now(),
    );
    const cutoff = new Date(Date.now() - BUDGET_RETENTION_DAYS * 86_400_000);
    run(
      d,
      `DELETE FROM setting WHERE key LIKE 'linkedin.budget.%' AND key < ?`,
      budgetKey(localDay(cutoff)),
    );
  } catch {
    /* a failed budget write must not crash the caller; the gate re-reads next time */
  }
}

export async function getBudgetRemaining(): Promise<number> {
  const perDay = getPerDayBudget();
  const used = readBudget().used;
  return Math.max(0, perDay - used);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard stop
// ─────────────────────────────────────────────────────────────────────────────

interface HaltRecord {
  day: string;
  reason: string;
  kind: 'checkpoint' | 'blocked' | 'auth' | 'manual';
  at: number;
}

function readHalt(): HaltRecord | null {
  const raw = settingRaw(HALT_KEY);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as HaltRecord;
    if (!rec || rec.day !== localDay()) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Stops the entire module until the next local day. There is deliberately no
 * retry, no proxy rotation and no backoff-and-continue path: LinkedIn asking us
 * to stop is treated as final.
 */
export async function haltForToday(
  reason: string,
  kind: HaltRecord['kind'] = 'manual',
): Promise<void> {
  const existing = readHalt();
  if (existing && existing.kind === kind && existing.reason === reason) return;

  const rec: HaltRecord = { day: localDay(), reason, kind, at: Date.now() };
  const d = db();
  if (d) {
    try {
      run(
        d,
        `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        HALT_KEY,
        JSON.stringify(rec),
        rec.at,
      );
      run(
        d,
        `INSERT INTO audit_log (actor, action, entity, entity_id, after_json, note)
         VALUES ('system', 'linkedin_halt', 'system', 'linkedin', ?, ?)`,
        JSON.stringify(rec),
        reason,
      );
    } catch {
      /* best effort — the in-process guard below still stops this run */
    }
  }
  memoryHalt = rec;

  if (kind === 'checkpoint') {
    // The operator has to clear this themselves. Put the page in front of them.
    void showCheckpointWindow();
  }
  void emitStatus();
}

/** Survives a DB outage so a halt is never silently lost mid-run. */
let memoryHalt: HaltRecord | null = null;

function currentHalt(): HaltRecord | null {
  const persisted = readHalt();
  if (persisted) return persisted;
  if (memoryHalt && memoryHalt.day === localDay()) return memoryHalt;
  return null;
}

/** Called after the operator resolves a checkpoint or signs back in. */
export async function clearHalt(): Promise<void> {
  memoryHalt = null;
  const d = db();
  if (d) {
    try {
      run(d, 'DELETE FROM setting WHERE key = ?', HALT_KEY);
    } catch {
      /* best effort */
    }
  }
  void emitStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// Active window
// ─────────────────────────────────────────────────────────────────────────────

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number(n));
  return (h ?? 0) * 60 + (m ?? 0);
}

function inActiveWindow(start: string, end: string, now = new Date()): boolean {
  const s = minutesOf(start);
  const e = minutesOf(end);
  const cur = now.getHours() * 60 + now.getMinutes();
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export async function getStatus(): Promise<LinkedInStatus> {
  const enabled = isEnabled();
  const perDay = getPerDayBudget();
  const budget = readBudget();
  const remaining = Math.max(0, perDay - budget.used);
  const windowStart = readTime('crawl.linkedinWindowStart', DEFAULT_WINDOW_START);
  const windowEnd = readTime('crawl.linkedinWindowEnd', DEFAULT_WINDOW_END);
  const inWindow = inActiveWindow(windowStart, windowEnd);
  const halt = currentHalt();
  const loggedIn = await isLoggedIn();
  const hasElectron = (await electron()) != null;
  const hasDb = db() != null;

  const base = {
    enabled,
    loggedIn,
    day: localDay(),
    budgetPerDay: perDay,
    budgetUsed: budget.used,
    budgetRemaining: remaining,
    nextRequestNotBefore: budget.lastRequestAt ? budget.lastRequestAt + REQUEST_GAP_MIN_MS : null,
    haltReason: halt?.reason ?? null,
    haltAt: halt?.at ?? null,
    windowStart,
    windowEnd,
    inWindow,
  };

  const make = (state: LinkedInState, message: string, needsOperator = false): LinkedInStatus => ({
    ...base,
    state,
    available: state === 'ready',
    message,
    needsOperator,
  });

  if (!hasElectron) return make('unsupported', 'LinkedIn needs the Electron main process.');
  if (!hasDb) return make('unsupported', 'Database not open — the daily budget cannot be enforced.');
  if (!enabled) return make('disabled', 'LinkedIn is off. Enable it in Settings → Rate limits.');
  if (halt) {
    const state: LinkedInState = halt.kind === 'checkpoint' ? 'checkpoint' : 'blocked';
    return make(state, `${halt.reason} — stopped for the rest of today.`, halt.kind === 'checkpoint');
  }
  if (!loggedIn) return make('logged_out', 'Not signed in to LinkedIn.', true);
  if (remaining <= 0) return make('budget_exhausted', `Daily budget of ${perDay} requests used.`);
  if (!inWindow) return make('outside_window', `Outside the active window (${windowStart}-${windowEnd}).`);

  return make('ready', `Ready — ${remaining} of ${perDay} requests left today.`);
}

export async function isAvailable(): Promise<boolean> {
  return (await getStatus()).available;
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate every network operation must pass through
// ─────────────────────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/** Serialises the gate so two concurrent callers cannot both take the last token. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Consumes `units` of today's budget and waits out the randomised gap since the
 * previous request. Returns ok:false rather than throwing so every caller is
 * forced to handle unavailability on the normal path.
 */
export async function acquireRequestSlot(units = 1): Promise<SlotResult> {
  return serialize(async () => {
    const status = await getStatus();
    if (!status.available) return { ok: false, reason: status.message, status };
    if (status.budgetRemaining < units) {
      return { ok: false, reason: `Daily LinkedIn budget exhausted (${status.budgetPerDay}/day).`, status };
    }

    const rec = readBudget();
    const gap = REQUEST_GAP_MIN_MS + Math.random() * (REQUEST_GAP_MAX_MS - REQUEST_GAP_MIN_MS);
    const wait = rec.lastRequestAt + gap - Date.now();
    if (wait > 0) await sleep(wait);

    // Re-check: a halt can land while we were sleeping through the gap.
    const after = currentHalt();
    if (after) {
      return { ok: false, reason: after.reason, status: await getStatus() };
    }

    writeBudget({ used: rec.used + units, lastRequestAt: Date.now() });
    const updated = await getStatus();
    void emitStatus(updated);
    return { ok: true, reason: 'ok', status: updated };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Status fan-out for the UI
// ─────────────────────────────────────────────────────────────────────────────

type StatusListener = (status: LinkedInStatus) => void;
const listeners = new Set<StatusListener>();

export function onStatusChange(cb: StatusListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function emitStatus(precomputed?: LinkedInStatus): Promise<void> {
  if (listeners.size === 0) return;
  const status = precomputed ?? (await getStatus());
  for (const cb of listeners) {
    try {
      cb(status);
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
