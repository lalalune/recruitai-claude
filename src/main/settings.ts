/**
 * Typed accessors over the `setting` table.
 *
 * Values are stored JSON-encoded under dotted keys ('icp.minHeadcount'), which
 * keeps the table a flat key/value store while the API stays nested. Secrets
 * never touch this table directly — they go through Electron safeStorage in
 * gmail/oauth.ts, and only the *presence* of a secret is exposed here.
 *
 * Deliberately free of any static `electron` import so the pipeline modules that
 * depend on it can also be loaded inside the pipeline.
 */

import path from 'node:path';
import { getDb, get, run } from './db/index.js';
// Secret storage and the Gmail connection state are owned by the gmail module;
// importing them rather than mirroring them is what keeps the two from
// disagreeing about whether the mailbox is connected.
import { getSecret, setSecret, isConnected, getAddress, needsReauth } from './gmail/oauth.js';
import type { Settings, SettingsPatch } from '../shared/ipc.js';
import type { IcpConfig } from '../shared/score.js';

export const SECRET_VERIFIER = 'verifier_api_key';
export const SECRET_ANTHROPIC = 'anthropic_api_key';

/** Renderer sends short names; normalise so both forms work. */
export function normaliseSecretKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (k === 'verifier' || k === 'verifier_api_key' || k === 'verifierkey') return SECRET_VERIFIER;
  if (k === 'anthropic' || k === 'anthropic_api_key' || k === 'anthropickey') return SECRET_ANTHROPIC;
  return k.replace(/[^a-z0-9_.-]/g, '_');
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  icp: {
    minHeadcount: 3,
    maxHeadcount: 1000,
    maxInhouseRecruiters: 2,
    staleDays: 45,
    excludedKeywords: [] as string[],
    requireBayArea: true,
  },
  sending: {
    perHour: 20,
    perDay: 150,
    windowStart: '09:00',
    windowEnd: '17:00',
    jitterPct: 40,
    weekends: false,
    signature: '',
    includeOptOutLine: true,
  },
  crawl: {
    concurrency: 10,
    linkedinPerDay: 25,
    linkedinEnabled: false,
  },
  spendCapUsd: 100,
};

type Group = 'icp' | 'sending' | 'crawl';

// ─────────────────────────────────────────────────────────────────────────────
// Raw key/value access
// ─────────────────────────────────────────────────────────────────────────────

export function getSetting<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>(getDb(), 'SELECT value FROM setting WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  run(
    getDb(),
    `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value ?? null),
    Date.now(),
  );
}

export function deleteSetting(key: string): void {
  run(getDb(), 'DELETE FROM setting WHERE key = ?', key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Data directory
// ─────────────────────────────────────────────────────────────────────────────

let dataDirOverride: string | null = null;

/** Called once from registerIpc() with the path the main process actually opened. */
export function setDataDir(dir: string): void {
  dataDirOverride = dir;
}

export function getDataDir(): string {
  if (dataDirOverride) return dataDirOverride;
  if (process.env.RECRUITAI_DATA) return process.env.RECRUITAI_DATA;
  return path.join(process.cwd(), 'data');
}

export function blobsDir(): string {
  return path.join(getDataDir(), 'blobs');
}

export function exportsDir(): string {
  return path.join(getDataDir(), 'exports');
}

export function backupsDir(): string {
  return path.join(getDataDir(), 'backups');
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped accessors
// ─────────────────────────────────────────────────────────────────────────────

function readGroup<G extends Group>(group: G): (typeof DEFAULT_SETTINGS)[G] {
  const defaults = DEFAULT_SETTINGS[group];
  const out: Record<string, unknown> = {};
  for (const [field, fallback] of Object.entries(defaults)) {
    out[field] = getSetting(`${group}.${field}`, fallback);
  }
  return out as (typeof DEFAULT_SETTINGS)[G];
}

function writeGroup<G extends Group>(group: G, patch: Partial<(typeof DEFAULT_SETTINGS)[G]>): void {
  const defaults = DEFAULT_SETTINGS[group] as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!(field in defaults)) continue;
    setSetting(`${group}.${field}`, value);
  }
}

export function getIcp(): IcpConfig {
  const icp = readGroup('icp');
  return {
    minHeadcount: clampInt(icp.minHeadcount, 0, 1_000_000, DEFAULT_SETTINGS.icp.minHeadcount),
    maxHeadcount: clampInt(icp.maxHeadcount, 1, 1_000_000, DEFAULT_SETTINGS.icp.maxHeadcount),
    maxInhouseRecruiters: clampInt(icp.maxInhouseRecruiters, 0, 500, DEFAULT_SETTINGS.icp.maxInhouseRecruiters),
    staleDays: clampInt(icp.staleDays, 1, 3650, DEFAULT_SETTINGS.icp.staleDays),
    excludedKeywords: Array.isArray(icp.excludedKeywords) ? icp.excludedKeywords.filter((k) => typeof k === 'string') : [],
    requireBayArea: icp.requireBayArea !== false,
  };
}

export function getSending(): (typeof DEFAULT_SETTINGS)['sending'] {
  const s = readGroup('sending');
  return {
    perHour: clampInt(s.perHour, 1, 200, DEFAULT_SETTINGS.sending.perHour),
    perDay: clampInt(s.perDay, 1, 500, DEFAULT_SETTINGS.sending.perDay),
    windowStart: isClock(s.windowStart) ? s.windowStart : DEFAULT_SETTINGS.sending.windowStart,
    windowEnd: isClock(s.windowEnd) ? s.windowEnd : DEFAULT_SETTINGS.sending.windowEnd,
    jitterPct: clampInt(s.jitterPct, 0, 90, DEFAULT_SETTINGS.sending.jitterPct),
    weekends: s.weekends === true,
    signature: typeof s.signature === 'string' ? s.signature : '',
    includeOptOutLine: s.includeOptOutLine !== false,
  };
}

export function getCrawl(): (typeof DEFAULT_SETTINGS)['crawl'] {
  const c = readGroup('crawl');
  return {
    concurrency: clampInt(c.concurrency, 1, 20, DEFAULT_SETTINGS.crawl.concurrency),
    linkedinPerDay: clampInt(c.linkedinPerDay, 0, 500, DEFAULT_SETTINGS.crawl.linkedinPerDay),
    linkedinEnabled: c.linkedinEnabled === true,
  };
}

export function getSpendCapUsd(): number {
  const v = getSetting('spendCapUsd', DEFAULT_SETTINGS.spendCapUsd);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.spendCapUsd;
}

export function getVerifierProvider(): Settings['keys']['verifierProvider'] {
  const v = getSetting<string>('keys.verifierProvider', 'none');
  return v === 'reoon' || v === 'bouncer' || v === 'millionverifier' ? v : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

export async function readSecret(key: string): Promise<string | null> {
  try {
    const value = await getSecret(normaliseSecretKey(key));
    return value && value.length ? value : null;
  } catch {
    return null;
  }
}

export async function writeSecret(key: string, value: string): Promise<void> {
  await setSecret(normaliseSecretKey(key), value);
}

export async function hasSecret(key: string): Promise<boolean> {
  return (await readSecret(key)) != null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The full Settings object the renderer sees
// ─────────────────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const [verifierKeySet, anthropicKeySet, gmailConnected] = await Promise.all([
    hasSecret(SECRET_VERIFIER),
    hasSecret(SECRET_ANTHROPIC),
    gmailConnectedSafe(),
  ]);

  return {
    icp: getIcp(),
    sending: getSending(),
    crawl: getCrawl(),
    gmail: {
      connected: gmailConnected,
      address: gmailConnected || getAddress() ? getAddress() : null,
      needsReauth: gmailConnected && needsReauth(),
    },
    keys: {
      verifierProvider: getVerifierProvider(),
      verifierKeySet,
      anthropicKeySet,
    },
    spendCapUsd: getSpendCapUsd(),
    dataDir: getDataDir(),
  };
}

export async function patchSettings(patch: SettingsPatch): Promise<Settings> {
  if (patch.icp) writeGroup('icp', patch.icp);
  if (patch.sending) writeGroup('sending', patch.sending);
  if (patch.crawl) writeGroup('crawl', patch.crawl);
  if (patch.spendCapUsd !== undefined && Number.isFinite(patch.spendCapUsd)) {
    const cap = Math.max(0, patch.spendCapUsd);
    setSetting('spendCapUsd', cap);
    // Mirror into the ledger's cap table so the spend guard is enforced by the
    // same rows that record the spend, not by an application-level copy.
    run(
      getDb(),
      `INSERT INTO spend_cap (provider, cap_usd_micros, spent_usd_micros) VALUES ('all', ?, 0)
       ON CONFLICT(provider) DO UPDATE SET cap_usd_micros = excluded.cap_usd_micros`,
      Math.round(cap * 1_000_000),
    );
  }
  return getSettings();
}

async function gmailConnectedSafe(): Promise<boolean> {
  try {
    return await isConnected();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function isClock(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
