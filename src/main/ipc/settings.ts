/**
 * Settings, API keys, Gmail, suppression, and the data-management handlers.
 *
 * Secrets are written through Electron safeStorage and never returned to the
 * renderer — the Settings object exposes only whether a key is present.
 */

import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, all, get, run, tx, backup, type Db } from '../db/index.js';
import { httpRequest } from '../util/http.js';
import {
  getSettings,
  patchSettings,
  writeSecret,
  readSecret,
  normaliseSecretKey,
  getDataDir,
  exportsDir,
  backupsDir,
  blobsDir,
  setSetting,
  getVerifierProvider,
  SECRET_ANTHROPIC,
  SECRET_VERIFIER,
} from '../settings.js';
import { emitEvent } from '../pipeline/run.js';
import { auditLog } from './companies.js';
import { addSuppressionRow } from './outreach.js';
import * as gmail from '../gmail/index.js';
import * as verify from '../verify/index.js';
import type { DashboardStats, SettingsPatch, SuppressionRow } from '../../shared/ipc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Suppression
// ─────────────────────────────────────────────────────────────────────────────

const VERIFIER_PROVIDERS = new Set(['reoon', 'bouncer', 'millionverifier', 'none']);

const SUPPRESSION_KINDS = new Set(['domain', 'email', 'company']);
const SUPPRESSION_REASONS = new Set([
  'existing_client',
  'active_contract',
  'past_rejection',
  'placed_candidate_employer',
  'competitor',
  'no_agency_policy',
  'replied_no',
  'bounced',
  'manual',
  'opt_out',
]);

export function listSuppressions(db: Db): SuppressionRow[] {
  return all<SuppressionRow>(
    db,
    `SELECT id, kind, value, reason, note, created_at AS createdAt FROM suppression ORDER BY created_at DESC`,
  );
}

export function addSuppression(db: Db, kind: string, value: string, reason: string, note?: string): void {
  if (!SUPPRESSION_KINDS.has(kind)) throw new Error(`Invalid suppression kind: ${kind}`);
  if (!SUPPRESSION_REASONS.has(reason)) throw new Error(`Invalid suppression reason: ${reason}`);
  const clean = value.trim().toLowerCase();
  if (!clean) throw new Error('Suppression value cannot be empty.');

  tx(db, () => {
    addSuppressionRow(db, kind, clean, reason, note ?? null);
    // Anything already drafted or queued for the newly-suppressed identity has
    // to be pulled out of the queue in the same transaction.
    if (kind === 'email') {
      run(
        db,
        `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
          WHERE state IN ('draft','queued')
            AND contact_id IN (SELECT id FROM contact WHERE lower(email) = ?)`,
        Date.now(),
        clean,
      );
    } else if (kind === 'domain') {
      run(
        db,
        `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
          WHERE state IN ('draft','queued')
            AND contact_id IN (SELECT id FROM contact WHERE lower(substr(email, instr(email, '@') + 1)) = ?)`,
        Date.now(),
        clean,
      );
      run(db, `UPDATE company SET status = 'suppressed', updated_at = ? WHERE lower(domain) = ?`, Date.now(), clean);
    } else {
      run(
        db,
        `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ? WHERE state IN ('draft','queued') AND company_id = ?`,
        Date.now(),
        value.trim(),
      );
      run(db, `UPDATE company SET status = 'suppressed', updated_at = ? WHERE id = ?`, Date.now(), value.trim());
    }
    auditLog(db, {
      actor: 'operator',
      action: 'addSuppression',
      entity: 'suppression',
      entityId: clean,
      after: { kind, value: clean, reason, note: note ?? null },
    });
  });

  emitEvent('data:changed', { entity: 'company' });
}

export function removeSuppression(db: Db, id: number): void {
  const row = get<SuppressionRow>(db, 'SELECT * FROM suppression WHERE id = ?', id);
  if (!row) return;
  run(db, 'DELETE FROM suppression WHERE id = ?', id);
  auditLog(db, {
    actor: 'operator',
    action: 'removeSuppression',
    entity: 'suppression',
    entityId: String(id),
    before: row,
  });
  emitEvent('data:changed', { entity: 'company' });
}

/**
 * Accepts either a bare list of values (one per line) or a header row naming
 * kind/value/reason/note columns — the two shapes an operator actually exports
 * from a CRM.
 */
export function importSuppressionsCsv(db: Db, csv: string): number {
  const rows = parseCsv(csv);
  if (rows.length === 0) return 0;

  let header: string[] | null = null;
  const first = rows[0]!.map((c) => c.trim().toLowerCase());
  if (first.includes('value') || first.includes('domain') || first.includes('email')) header = first;

  const body = header ? rows.slice(1) : rows;
  const col = (name: string) => (header ? header.indexOf(name) : -1);
  const valueIdx = header ? Math.max(col('value'), col('domain'), col('email')) : 0;
  const kindIdx = col('kind');
  const reasonIdx = col('reason');
  const noteIdx = col('note');

  let imported = 0;
  tx(db, () => {
    for (const row of body) {
      const raw = (row[valueIdx >= 0 ? valueIdx : 0] ?? '').trim().toLowerCase();
      if (!raw || raw.startsWith('#')) continue;

      const kind =
        kindIdx >= 0 && SUPPRESSION_KINDS.has((row[kindIdx] ?? '').trim().toLowerCase())
          ? (row[kindIdx] ?? '').trim().toLowerCase()
          : raw.includes('@')
            ? 'email'
            : 'domain';
      const reason =
        reasonIdx >= 0 && SUPPRESSION_REASONS.has((row[reasonIdx] ?? '').trim().toLowerCase())
          ? (row[reasonIdx] ?? '').trim().toLowerCase()
          : 'manual';
      const note = noteIdx >= 0 ? (row[noteIdx] ?? '').trim() || null : 'Imported from CSV';

      addSuppressionRow(db, kind, raw, reason, note);
      imported++;
    }
  });

  emitEvent('data:changed', { entity: 'company' });
  return imported;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  // A leading =, +, - or @ is interpreted as a formula by Excel and Sheets.
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return `${lines.join('\n')}\n`;
}

const EXPORTS: Record<'companies' | 'contacts' | 'drafts', { headers: string[]; sql: string }> = {
  companies: {
    headers: [
      'id', 'name', 'domain', 'website', 'headcount', 'industry', 'hq_location', 'in_bay_area',
      'funding_stage', 'last_round_at', 'yc_batch', 'ats_platform', 'ats_token', 'careers_url',
      'linkedin_url', 'open_req_count', 'open_req_eng_count', 'stale_req_count', 'max_days_open',
      'recruiter_count', 'has_inhouse_ta', 'no_agency_policy', 'estimated_fee_usd', 'quality_score',
      'score_raw', 'score_headline', 'disqualified', 'status', 'reviewed', 'contact_count',
      'verified_contact_count', 'notes', 'created_at', 'updated_at',
    ],
    sql: `SELECT c.id, c.name, c.domain, c.website, c.headcount, c.industry, c.hq_location, c.in_bay_area,
                 c.funding_stage, c.last_round_at, c.yc_batch, c.ats_platform, c.ats_token, c.careers_url,
                 c.linkedin_url, c.open_req_count, c.open_req_eng_count, c.stale_req_count, c.max_days_open,
                 c.recruiter_count, c.has_inhouse_ta, c.no_agency_policy, c.estimated_fee_usd, c.quality_score,
                 c.score_raw, c.score_headline, c.disqualified, c.status, c.reviewed,
                 (SELECT count(*) FROM contact ct WHERE ct.company_id = c.id) AS contact_count,
                 (SELECT count(*) FROM contact ct WHERE ct.company_id = c.id AND ct.email_verdict = 'valid') AS verified_contact_count,
                 c.notes, c.created_at, c.updated_at
            FROM company c WHERE c.canonical_id IS NULL
           ORDER BY c.quality_score DESC, c.open_req_count DESC`,
  },
  contacts: {
    headers: [
      'id', 'company_id', 'company_name', 'company_domain', 'full_name', 'first_name', 'last_name',
      'title', 'persona', 'seniority', 'email', 'email_source', 'email_verdict', 'email_verified_at',
      'phone', 'linkedin_url', 'is_primary', 'contact_score', 'status', 'reviewed', 'notes',
      'company_quality_score', 'suppressed',
    ],
    sql: `SELECT c.id, c.company_id, co.name AS company_name, co.domain AS company_domain, c.full_name,
                 c.first_name, c.last_name, c.title, c.persona, c.seniority, c.email, c.email_source,
                 c.email_verdict, c.email_verified_at, c.phone, c.linkedin_url, c.is_primary,
                 c.contact_score, c.status, c.reviewed, c.notes, co.quality_score AS company_quality_score,
                 EXISTS (SELECT 1 FROM suppression s
                          WHERE (s.kind = 'email' AND lower(s.value) = lower(c.email))
                             OR (s.kind = 'domain' AND c.email IS NOT NULL
                                 AND lower(s.value) = lower(substr(c.email, instr(c.email, '@') + 1)))
                             OR (s.kind = 'company' AND s.value = co.id)) AS suppressed
            FROM contact c JOIN company co ON co.id = c.company_id
           ORDER BY co.quality_score DESC, c.contact_score DESC`,
  },
  drafts: {
    headers: [
      'id', 'company_id', 'company_name', 'contact_id', 'contact_name', 'to_email', 'email_verdict',
      'subject', 'body', 'template', 'generated_by', 'edited', 'state', 'scheduled_at', 'sent_at',
      'outcome', 'created_at',
    ],
    sql: `SELECT d.id, d.company_id, co.name AS company_name, d.contact_id, c.full_name AS contact_name,
                 c.email AS to_email, c.email_verdict, d.subject, d.body, d.template, d.generated_by,
                 d.edited, d.state, d.scheduled_at, s.sent_at, s.outcome, d.created_at
            FROM draft d
            JOIN contact c ON c.id = d.contact_id
            JOIN company co ON co.id = d.company_id
            LEFT JOIN send s ON s.draft_id = d.id
           ORDER BY d.created_at DESC`,
  },
};

export function exportCsv(db: Db, what: 'companies' | 'contacts' | 'drafts'): string {
  const spec = EXPORTS[what];
  if (!spec) throw new Error(`Unknown export: ${what}`);

  const rows = all<Record<string, unknown>>(db, spec.sql);
  const dir = exportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${what}-${stamp}.csv`);
  fs.writeFileSync(file, toCsv(spec.headers, rows), 'utf8');
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

export function getStats(db: Db): DashboardStats {
  const one = (sql: string, ...args: unknown[]) => get<{ n: number }>(db, sql, ...args)?.n ?? 0;
  return {
    companies: one('SELECT count(*) AS n FROM company WHERE canonical_id IS NULL'),
    reviewed: one('SELECT count(*) AS n FROM company WHERE canonical_id IS NULL AND reviewed = 1'),
    approved: one(`SELECT count(*) AS n FROM company WHERE status = 'approved'`),
    contacts: one('SELECT count(*) AS n FROM contact'),
    verifiedContacts: one(`SELECT count(*) AS n FROM contact WHERE email_verdict = 'valid'`),
    openReqs: one('SELECT count(*) AS n FROM req WHERE closed_at IS NULL'),
    drafts: one(`SELECT count(*) AS n FROM draft WHERE state IN ('draft','queued')`),
    sent: one(`SELECT count(*) AS n FROM send WHERE outcome != 'failed' AND sent_at IS NOT NULL`),
    replies: one(`SELECT count(*) AS n FROM inbound WHERE kind = 'reply'`),
    bounces: one(`SELECT count(*) AS n FROM inbound WHERE kind = 'bounce'`),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Key tests
// ─────────────────────────────────────────────────────────────────────────────

async function testAnthropicKey(): Promise<{ ok: boolean; message: string }> {
  const key = await readSecret(SECRET_ANTHROPIC);
  if (!key) return { ok: false, message: 'No Anthropic key saved.' };

  // GET /v1/models is free and authenticated, so it proves the key works
  // without writing a ledger row or spending anything.
  const res = await httpRequest('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    timeoutMs: 20_000,
    maxRetries: 0,
  });

  if (res.ok) return { ok: true, message: 'Anthropic key is valid.' };
  if (res.status === 401) return { ok: false, message: 'Anthropic rejected the key (401).' };
  if (res.blocked) return { ok: false, message: `Anthropic returned ${res.status}; not retrying.` };
  return { ok: false, message: res.error ?? `Anthropic returned HTTP ${res.status}.` };
}

async function testVerifierKey(db: Db): Promise<{ ok: boolean; message: string }> {
  const provider = getVerifierProvider();
  if (provider === 'none') return { ok: false, message: 'No verification provider selected in Settings.' };
  if (!(await readSecret(SECRET_VERIFIER))) return { ok: false, message: `No ${provider} key saved.` };
  try {
    return await verify.testVerifierKey(db);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshots
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Returns a data URL, or null. Reads are confined to <dataDir>/blobs. */
export function getScreenshot(relPath: string): string | null {
  if (!relPath || typeof relPath !== 'string') return null;
  const root = path.resolve(blobsDir());
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;

  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerSettingsIpc(): void {
  ipcMain.handle('getSettings', async () => getSettings());

  ipcMain.handle('patchSettings', async (_e, patch: SettingsPatch) => patchSettings(patch ?? {}));

  ipcMain.handle('setSecret', async (_e, key: string, value: string) => {
    const raw = String(key ?? '').trim().toLowerCase();

    // Not actually a secret. SettingsPatch has no `keys` branch, so the choice
    // of verification provider rides the same channel as the key it selects;
    // it is stored as an ordinary setting rather than encrypted.
    if (raw === 'verifier_provider' || raw === 'verifierprovider') {
      const provider = VERIFIER_PROVIDERS.has(String(value)) ? String(value) : 'none';
      setSetting('keys.verifierProvider', provider);
      auditLog(getDb(), {
        actor: 'operator',
        action: 'setVerifierProvider',
        entity: 'setting',
        entityId: 'keys.verifierProvider',
        after: { provider },
      });
      return;
    }

    const normalised = normaliseSecretKey(raw);
    await writeSecret(normalised, String(value ?? ''));
    auditLog(getDb(), { actor: 'operator', action: 'setSecret', entity: 'setting', entityId: normalised });
  });

  ipcMain.handle('testKey', async (_e, which: 'verifier' | 'anthropic') =>
    which === 'anthropic' ? testAnthropicKey() : testVerifierKey(getDb()),
  );

  ipcMain.handle('connectGmail', async () => {
    const result = await gmail.connectGmail();
    emitEvent('data:changed', { entity: 'draft' });
    return result;
  });

  ipcMain.handle('disconnectGmail', async () => {
    await gmail.disconnectGmail();
  });

  ipcMain.handle('testGmail', async () => gmail.testConnection());

  // suppression
  ipcMain.handle('listSuppressions', async () => listSuppressions(getDb()));
  ipcMain.handle('addSuppression', async (_e, kind: string, value: string, reason: string, note?: string) => {
    addSuppression(getDb(), kind, value, reason, note);
  });
  ipcMain.handle('removeSuppression', async (_e, id: number) => {
    removeSuppression(getDb(), Number(id));
  });
  ipcMain.handle('importSuppressionsCsv', async (_e, csv: string) => importSuppressionsCsv(getDb(), String(csv ?? '')));

  // misc
  ipcMain.handle('getStats', async () => getStats(getDb()));

  ipcMain.handle('exportCsv', async (_e, what: 'companies' | 'contacts' | 'drafts') => exportCsv(getDb(), what));

  ipcMain.handle('backupNow', async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(dir, `recruitai-manual-${stamp}.db`);
    backup(getDb(), dest);
    return dest;
  });

  ipcMain.handle('openDataDir', async () => {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle('openExternal', async (_e, url: string) => {
    // Only ever hand http(s) to the OS handler; anything else could be a
    // file:// or custom-scheme link arriving from scraped page content.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Only http and https links can be opened externally.');
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('getScreenshot', async (_e, relPath: string) => getScreenshot(relPath));
}
