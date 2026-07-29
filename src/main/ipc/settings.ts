/**
 * Settings, API keys, Gmail, suppression, and the data-management handlers.
 *
 * Secrets are written through Electron safeStorage and never returned to the
 * renderer — the Settings object exposes only whether a key is present.
 */

import { shell } from 'electron';
import { handle } from './guard.js';
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
import { emitEvent, appendLog } from '../pipeline/run.js';
import { recomputeCompany } from '../pipeline/scoring.js';
import {
  companySuppressionValues,
  COMPANY_MATCHES_VALUE,
  COMPANY_SUPPRESSION_MATCH,
} from '../pipeline/suppression.js';
import { verifierProviderSchema } from '../../shared/schemas.js';
import { auditLog } from './companies.js';
import { addSuppressionRow } from './outreach.js';
import * as gmail from '../gmail/index.js';
import * as verify from '../verify/index.js';
import type { DashboardStats, SettingsPatch, SuppressionRow } from '../../shared/ipc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Suppression
// ─────────────────────────────────────────────────────────────────────────────


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
      // Company suppressions accept an id, a domain, or a typed name — match
      // all three identities, exactly as the queue barriers do. An ambiguous
      // pre-emptive value ("Node.js") resolves to BOTH readings; the side
      // effects run for each.
      for (const cval of companySuppressionValues(db, value)) {
        run(
          db,
          `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
            WHERE state IN ('draft','queued')
              AND company_id IN (SELECT company.id FROM company WHERE ${COMPANY_MATCHES_VALUE})`,
          Date.now(),
          cval,
          cval,
          cval,
        );
        run(
          db,
          `UPDATE company SET status = 'suppressed', updated_at = ? WHERE ${COMPANY_MATCHES_VALUE}`,
          Date.now(),
          cval,
          cval,
          cval,
        );
      }
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
  emitEvent('data:changed', { entity: 'suppression' });
}

export function removeSuppression(db: Db, id: number): void {
  const row = get<SuppressionRow>(db, 'SELECT * FROM suppression WHERE id = ?', id);
  if (!row) return;

  const restored: string[] = [];
  tx(db, () => {
    run(db, 'DELETE FROM suppression WHERE id = ?', id);

    // Un-suppression must be possible: a company whose status is 'suppressed'
    // and which no remaining rule matches goes back through scoring, otherwise
    // a mistaken suppression is permanent (status 'suppressed' short-circuits
    // recomputeCompany forever).
    //
    // Scoped to companies THIS row could have matched — an unscoped sweep also
    // flipped companies the operator suppressed manually with no rule at all.
    let candidatesSql: string | null = null;
    let candidateArgs: string[] = [];
    if (row.kind === 'domain') {
      candidatesSql = `co.domain IS NOT NULL AND lower(co.domain) = ?`;
      candidateArgs = [row.value.toLowerCase()];
    } else if (row.kind === 'company') {
      candidatesSql = `(upper(?) = co.id OR ? = co.name_norm OR (co.domain IS NOT NULL AND ? = lower(co.domain)))`;
      candidateArgs = [row.value, row.value, row.value];
    }
    // Email-kind rows never flipped a company's status; nothing to restore.

    const stuck = candidatesSql
      ? all<{ id: string }>(
          db,
          `SELECT co.id FROM company co
            WHERE co.status = 'suppressed'
              AND ${candidatesSql}
              AND NOT EXISTS (
                SELECT 1 FROM suppression s
                 WHERE (s.kind = 'company' AND ${COMPANY_SUPPRESSION_MATCH})
                    OR (s.kind = 'domain' AND co.domain IS NOT NULL AND s.value = lower(co.domain))
              )`,
          ...candidateArgs,
        )
      : [];
    for (const c of stuck) {
      run(db, `UPDATE company SET status = 'scored', updated_at = ? WHERE id = ?`, Date.now(), c.id);
      restored.push(c.id);
    }

    auditLog(db, {
      actor: 'operator',
      action: 'removeSuppression',
      entity: 'suppression',
      entityId: String(id),
      before: row,
      after: restored.length ? { restoredCompanies: restored } : undefined,
    });
  });

  for (const cid of restored) recomputeCompany(db, cid);
  emitEvent('data:changed', { entity: 'company' });
  emitEvent('data:changed', { entity: 'suppression' });
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

    // The same side effects addSuppression applies one-by-one, run set-based
    // over the whole table (idempotent): without this, imported identities
    // kept their queued drafts visible-but-unsendable and their companies
    // 'approved'.
    if (imported > 0) {
      run(
        db,
        `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
          WHERE state IN ('draft','queued')
            AND contact_id IN (
              SELECT c.id FROM contact c
               WHERE c.email IS NOT NULL AND EXISTS (
                 SELECT 1 FROM suppression s
                  WHERE (s.kind = 'email'  AND s.value = lower(c.email))
                     OR (s.kind = 'domain' AND s.value = lower(substr(c.email, instr(c.email, '@') + 1)))))`,
        Date.now(),
      );
      run(
        db,
        `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
          WHERE state IN ('draft','queued')
            AND company_id IN (
              SELECT co.id FROM company co
               WHERE EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'company' AND ${COMPANY_SUPPRESSION_MATCH}))`,
        Date.now(),
      );
      run(
        db,
        `UPDATE company AS co SET status = 'suppressed', updated_at = ?
          WHERE co.status != 'suppressed'
            AND EXISTS (
              SELECT 1 FROM suppression s
               WHERE (s.kind = 'domain' AND co.domain IS NOT NULL AND s.value = lower(co.domain))
                  OR (s.kind = 'company' AND ${COMPANY_SUPPRESSION_MATCH}))`,
        Date.now(),
      );
    }
  });

  emitEvent('data:changed', { entity: 'company' });
  emitEvent('data:changed', { entity: 'draft' });
  emitEvent('data:changed', { entity: 'suppression' });
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
            FROM company c WHERE c.canonical_id IS NULL /*SCOPE*/
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
                          WHERE (s.kind = 'email' AND s.value = lower(c.email))
                             OR (s.kind = 'domain' AND c.email IS NOT NULL
                                 AND s.value = lower(substr(c.email, instr(c.email, '@') + 1)))
                             OR (s.kind = 'company' AND ${COMPANY_SUPPRESSION_MATCH})) AS suppressed
            FROM contact c JOIN company co ON co.id = c.company_id WHERE 1=1 /*SCOPE*/
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
           WHERE 1=1 /*SCOPE*/
           ORDER BY d.created_at DESC`,
  },
};

/** Which column scopes each export when a company-id list is passed. */
const EXPORT_SCOPE_COL: Record<'companies' | 'contacts' | 'drafts', string> = {
  companies: 'c.id',
  contacts: 'c.company_id',
  drafts: 'd.company_id',
};

export function exportCsv(db: Db, what: 'companies' | 'contacts' | 'drafts', companyIds?: string[]): string {
  const spec = EXPORTS[what];
  if (!spec) throw new Error(`Unknown export: ${what}`);

  let sql = spec.sql.replace('/*SCOPE*/', '');
  let args: string[] = [];
  if (companyIds && companyIds.length > 0) {
    const ph = companyIds.map(() => '?').join(',');
    sql = spec.sql.replace('/*SCOPE*/', `AND ${EXPORT_SCOPE_COL[what]} IN (${ph})`);
    args = companyIds;
  }

  const rows = all<Record<string, unknown>>(db, sql, ...args);
  const dir = exportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${what}-${stamp}.csv`);
  // UTF-8 BOM: Excel (Windows, and older Mac) opens BOM-less UTF-8 CSVs as
  // mojibake on double-click — CJK and accented names in exports were garbage.
  fs.writeFileSync(file, `﻿${toCsv(spec.headers, rows)}`, 'utf8');
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
    const result = await verify.testVerifierKey(db);
    // The measured accuracy of pattern-guessed addresses so far — the number
    // that says whether paying to verify guesses is worth it on this ICP.
    const acc = verify.measuredPatternAccuracy(db);
    if (result.ok && acc.rate != null) {
      return {
        ok: true,
        message: `${result.message} Pattern-guess accuracy so far: ${(acc.rate * 100).toFixed(0)}% over ${acc.valid + acc.invalid} conclusive checks.`,
      };
    }
    return result;
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

/**
 * safeStorage has no keyring to talk to on some Linux desktops, and the secret
 * store falls back to marked plaintext there. The store already warns — to
 * stderr, which nobody running a packaged app ever sees, while the UI's own
 * toast says "saved to the OS keychain". Put it where the operator is looking.
 */
async function warnIfPlaintext(): Promise<void> {
  if (await gmail.encryptionAvailable()) return;
  appendLog(
    'settings',
    'warn',
    'This system has no OS keychain available (safeStorage), so saved keys and the Gmail refresh token ' +
      'are stored as PLAINTEXT in the local database. Install a system keyring (gnome-keyring / kwallet) ' +
      'and save them again.',
  );
}

export function registerSettingsIpc(): void {
  handle('getSettings', async () => getSettings());

  handle('patchSettings', async (patch: SettingsPatch) => patchSettings(patch));

  handle('setSecret', async (key: string, value: string) => {
    const raw = key.trim().toLowerCase();

    // Not actually a secret. SettingsPatch has no `keys` branch, so the choice
    // of verification provider rides the same channel as the key it selects;
    // it is stored as an ordinary setting rather than encrypted.
    if (raw === 'verifier_provider' || raw === 'verifierprovider') {
      // One provider list for the whole app: the zod enum, not a shadow Set.
      const parsed = verifierProviderSchema.safeParse(value);
      const provider = parsed.success ? parsed.data : 'none';
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
    // The schema only constrains the SHAPE of the key. Without this the
    // renderer could name any row in the `setting` table: 'gmail.refresh_token'
    // (plant or destroy the mailbox grant), 'gmail.client_secret' (point the
    // consent flow at someone else's OAuth client), or 'linkedin.halt' /
    // 'linkedin.budget.<day>' — whose readers JSON.parse the value, so writing
    // an opaque ciphertext there makes the day-stop and the daily budget read
    // back as "none", which is exactly the retry path session.ts promises does
    // not exist. Only the two keys the Settings screen actually writes are
    // reachable from here.
    if (normalised !== SECRET_VERIFIER && normalised !== SECRET_ANTHROPIC) {
      throw new Error(`Unknown secret "${key}".`);
    }
    await writeSecret(normalised, value);
    if (value) await warnIfPlaintext();
    auditLog(getDb(), { actor: 'operator', action: 'setSecret', entity: 'setting', entityId: normalised });
  });

  handle('testKey', async (which: 'verifier' | 'anthropic') =>
    which === 'anthropic' ? testAnthropicKey() : testVerifierKey(getDb()),
  );

  /**
   * The Google OAuth client, on its own channel.
   *
   * setSecret refuses these two keys by design — a renderer able to name
   * `gmail.client_secret` could repoint the consent flow at someone else's
   * OAuth client. That protection is worth keeping, but it left the operator
   * with NO way to supply a client at all outside environment variables, which
   * a .app launched from Finder never inherits: Connect Gmail could therefore
   * only ever fail. This channel is the deliberate, audited, shape-checked way
   * in, and it writes both halves together so a half-configured client cannot
   * exist.
   */
  handle('setGmailClient', async (clientId: string, clientSecret: string) => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    // Both or neither: a client id with no secret fails at Google with an
    // error the operator cannot act on, and looks configured until then.
    if (Boolean(id) !== Boolean(secret)) {
      throw new Error('A Google OAuth client needs both the client ID and the client secret.');
    }
    await writeSecret(gmail.KEY_CLIENT_ID, id);
    await writeSecret(gmail.KEY_CLIENT_SECRET, secret);
    if (secret) await warnIfPlaintext();
    auditLog(getDb(), {
      actor: 'operator',
      action: id ? 'setGmailClient' : 'clearGmailClient',
      entity: 'setting',
      entityId: gmail.KEY_CLIENT_ID,
    });
  });

  handle('connectGmail', async () => {
    const result = await gmail.connectGmail();
    if (result.ok) await warnIfPlaintext();
    emitEvent('data:changed', { entity: 'draft' });
    return result;
  });

  handle('disconnectGmail', async () => {
    await gmail.disconnectGmail();
  });

  handle('testGmail', async () => gmail.testConnection());

  // suppression
  handle('listSuppressions', async () => listSuppressions(getDb()));
  handle('addSuppression', async (kind: string, value: string, reason: string, note?: string) => {
    addSuppression(getDb(), kind, value, reason, note);
  });
  handle('removeSuppression', async (id: number) => {
    removeSuppression(getDb(), id);
  });
  handle('importSuppressionsCsv', async (csv: string) => importSuppressionsCsv(getDb(), csv));

  // misc
  handle('getStats', async () => getStats(getDb()));

  handle('exportCsv', async (what: 'companies' | 'contacts' | 'drafts', companyIds?: string[]) =>
    exportCsv(getDb(), what, companyIds),
  );

  handle('backupNow', async () => {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(dir, `recruitai-manual-${stamp}.db`);
    backup(getDb(), dest);
    return dest;
  });

  handle('openDataDir', async () => {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  handle('openExternal', async (url: string) => {
    // The schema already enforces http(s); this second check is deliberate
    // defence in depth at the OS boundary, in case the schema ever loosens.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Only http and https links can be opened externally.');
    }
    await shell.openExternal(url);
  });

  handle('getScreenshot', async (relPath: string) => getScreenshot(relPath));
}
