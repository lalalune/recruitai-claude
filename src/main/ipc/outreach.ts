/**
 * Drafts, the paced sender, and inbound handling.
 *
 * The suppression guarantee is enforced by `SENDABLE_PREDICATE`, which is the
 * only way a draft ever reaches the sender. A suppressed domain or address is
 * not merely hidden in the UI — there is no query in this file that can select
 * one, so the send path is physically unable to emit to it.
 *
 * Idempotency: the `send` row (whose id is also the X-RecruitAI-Send-Id header)
 * is written before the Gmail call. A crash mid-send therefore leaves a visible
 * 'pending' row that startup marks failed for the operator to judge — it is
 * never silently retried, because a double-send is worse than a missed send.
 */

import { ipcMain } from 'electron';
import { getDb, all, get, run, tx, ulid, type Db } from '../db/index.js';
import { getSending } from '../settings.js';
import { emitEvent } from '../pipeline/run.js';
import { generateDraftFor, DraftNotPossible } from '../pipeline/drafts.js';
import { recomputeCompany } from '../pipeline/scoring.js';
import { auditLog } from './companies.js';
import * as gmail from '../gmail/index.js';
import { SuppressedRecipientError } from '../gmail/send.js';
import type { DraftRow, InboundRow, SendStats } from '../../shared/ipc.js';
import type { VerificationVerdict } from '../../shared/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// The suppression barrier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applied to every query that can lead to an outbound message. Domain matching
 * uses the address's own domain part rather than the company's, so a contact
 * whose address sits on a suppressed domain is caught even if the company row
 * says something else.
 */
const SENDABLE_PREDICATE = `
  c.email IS NOT NULL
  AND c.status NOT IN ('rejected','bounced')
  AND co.status = 'approved'
  AND co.disqualified IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM suppression s
     WHERE (s.kind = 'email'   AND lower(s.value) = lower(c.email))
        OR (s.kind = 'domain'  AND lower(s.value) = lower(substr(c.email, instr(c.email, '@') + 1)))
        OR (s.kind = 'company' AND (s.value = co.id OR (co.domain IS NOT NULL AND lower(s.value) = lower(co.domain))))
  )
`;

// ─────────────────────────────────────────────────────────────────────────────
// Draft rows
// ─────────────────────────────────────────────────────────────────────────────

interface DraftRowRaw {
  id: string;
  companyId: string;
  companyName: string;
  contactId: string;
  contactName: string;
  contactTitle: string | null;
  toEmail: string | null;
  emailVerdict: VerificationVerdict;
  subject: string;
  body: string;
  reqIds: string;
  state: string;
  edited: number;
  scheduledAt: number | null;
  qualityScore: number | null;
}

const DRAFT_SELECT = `
  SELECT d.id, d.company_id AS companyId, co.name AS companyName, d.contact_id AS contactId,
         c.full_name AS contactName, c.title AS contactTitle, c.email AS toEmail,
         c.email_verdict AS emailVerdict, d.subject, d.body, d.req_ids AS reqIds, d.state,
         d.edited, d.scheduled_at AS scheduledAt, co.quality_score AS qualityScore
    FROM draft d
    JOIN contact c ON c.id = d.contact_id
    JOIN company co ON co.id = d.company_id
`;

function toDraftRow(r: DraftRowRaw): DraftRow {
  let reqIds: number[] = [];
  try {
    const parsed = JSON.parse(r.reqIds);
    if (Array.isArray(parsed)) reqIds = parsed.map(Number).filter(Number.isFinite);
  } catch {
    reqIds = [];
  }
  return { ...r, reqIds, edited: r.edited === 1 };
}

export function listDrafts(db: Db, state?: string): DraftRow[] {
  const clauses = state ? 'WHERE d.state = ?' : `WHERE d.state != 'skipped'`;
  const args = state ? [state] : [];
  return all<DraftRowRaw>(
    db,
    `${DRAFT_SELECT} ${clauses} ORDER BY d.scheduled_at IS NULL, d.scheduled_at, co.quality_score DESC, d.created_at`,
    ...args,
  ).map(toDraftRow);
}

export function readDraft(db: Db, id: string): DraftRow {
  const row = get<DraftRowRaw>(db, `${DRAFT_SELECT} WHERE d.id = ?`, id);
  if (!row) throw new Error(`Unknown draft: ${id}`);
  return toDraftRow(row);
}

export function patchDraft(db: Db, id: string, patch: { subject?: string; body?: string }): DraftRow {
  const before = get<{ subject: string; body: string; state: string }>(
    db,
    'SELECT subject, body, state FROM draft WHERE id = ?',
    id,
  );
  if (!before) throw new Error(`Unknown draft: ${id}`);
  if (before.state === 'sent' || before.state === 'sending') {
    throw new Error('This message has already left the queue and cannot be edited.');
  }

  const subject = patch.subject !== undefined ? String(patch.subject) : before.subject;
  const body = patch.body !== undefined ? String(patch.body) : before.body;

  tx(db, () => {
    run(
      db,
      'UPDATE draft SET subject = ?, body = ?, edited = 1, updated_at = ? WHERE id = ?',
      subject,
      body,
      Date.now(),
      id,
    );
    auditLog(db, {
      actor: 'operator',
      action: 'patchDraft',
      entity: 'draft',
      entityId: id,
      before,
      after: { subject, body },
    });
  });

  emitEvent('data:changed', { entity: 'draft', id });
  return readDraft(db, id);
}

/** Queue a draft, assigning the next free slot in the paced schedule. */
export function queueDraft(db: Db, id: string): void {
  const row = get<{ id: string; email: string | null }>(
    db,
    `SELECT d.id, c.email FROM draft d
       JOIN contact c ON c.id = d.contact_id
       JOIN company co ON co.id = d.company_id
      WHERE d.id = ? AND d.state IN ('draft','failed') AND ${SENDABLE_PREDICATE}`,
    id,
  );
  if (!row) {
    throw new Error('This draft cannot be queued: the company, contact, or suppression rules exclude it.');
  }

  run(db, `UPDATE draft SET state = 'queued', scheduled_at = ?, updated_at = ? WHERE id = ?`, nextSlot(db), Date.now(), id);
  auditLog(db, { actor: 'operator', action: 'queueDraft', entity: 'draft', entityId: id });
  emitEvent('data:changed', { entity: 'draft', id });
  emitSendProgress(db);
}

export function skipDraft(db: Db, id: string): void {
  run(db, `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ? WHERE id = ?`, Date.now(), id);
  auditLog(db, { actor: 'operator', action: 'skipDraft', entity: 'draft', entityId: id });
  emitEvent('data:changed', { entity: 'draft', id });
  emitSendProgress(db);
}

// ─────────────────────────────────────────────────────────────────────────────
// The governor
// ─────────────────────────────────────────────────────────────────────────────

function startOfLocalDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isInSendWindow(now = new Date()): boolean {
  const sending = getSending();
  if (!sending.weekends && (now.getDay() === 0 || now.getDay() === 6)) return false;
  const start = parseClock(sending.windowStart);
  const end = parseClock(sending.windowEnd);
  const minute = minutesOfDay(now);
  // A window that wraps past midnight is legal; treat it as two ranges.
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function sentToday(db: Db): number {
  const row = get<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM send WHERE sent_at >= ? AND outcome != 'failed'`,
    startOfLocalDay(),
  );
  return row?.n ?? 0;
}

export function sentThisHour(db: Db): number {
  const row = get<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM send WHERE sent_at >= ? AND outcome != 'failed'`,
    Date.now() - 3_600_000,
  );
  return row?.n ?? 0;
}

export function queuedCount(db: Db): number {
  const row = get<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM draft d JOIN contact c ON c.id = d.contact_id JOIN company co ON co.id = d.company_id
      WHERE d.state = 'queued' AND ${SENDABLE_PREDICATE}`,
  );
  return row?.n ?? 0;
}

/** Base interval between sends, before jitter. */
function baseIntervalMs(): number {
  const sending = getSending();
  return Math.max(1000, Math.floor(3_600_000 / Math.max(1, sending.perHour)));
}

function jitteredIntervalMs(): number {
  const sending = getSending();
  const base = baseIntervalMs();
  const spread = (sending.jitterPct / 100) * base;
  return Math.max(5_000, Math.round(base - spread + Math.random() * spread * 2));
}

/** Next scheduled slot for a newly-queued draft, so the list shows real times. */
function nextSlot(db: Db): number {
  const last = get<{ t: number | null }>(db, `SELECT MAX(scheduled_at) AS t FROM draft WHERE state = 'queued'`);
  const floor = Math.max(Date.now(), last?.t ?? 0);
  return floor + baseIntervalMs();
}

let sendTimer: NodeJS.Timeout | null = null;
let sendingActive = false;
let nextSendAt: number | null = null;

export function getSendStats(db: Db): SendStats {
  const sending = getSending();
  return {
    today: sentToday(db),
    thisHour: sentThisHour(db),
    dailyLimit: sending.perDay,
    hourlyLimit: sending.perHour,
    queued: queuedCount(db),
    nextSendAt,
    running: sendingActive,
    windowStart: sending.windowStart,
    windowEnd: sending.windowEnd,
    inWindow: isInSendWindow(),
  };
}

function emitSendProgress(db: Db): void {
  emitEvent('send:progress', getSendStats(db));
}

interface SendCandidate {
  draftId: string;
  companyId: string;
  contactId: string;
  toEmail: string;
  subject: string;
  body: string;
}

function nextCandidate(db: Db, draftId?: string): SendCandidate | null {
  const extra = draftId ? 'AND d.id = ?' : '';
  const args = draftId ? [draftId] : [];
  const row = get<SendCandidate>(
    db,
    `SELECT d.id AS draftId, d.company_id AS companyId, d.contact_id AS contactId,
            c.email AS toEmail, d.subject, d.body
       FROM draft d
       JOIN contact c ON c.id = d.contact_id
       JOIN company co ON co.id = d.company_id
      WHERE d.state = 'queued' AND ${SENDABLE_PREDICATE} ${extra}
      ORDER BY d.scheduled_at IS NULL, d.scheduled_at, co.quality_score DESC, d.created_at
      LIMIT 1`,
    ...args,
  );
  return row ?? null;
}

export type SendResult =
  | { ok: true; sendId: string }
  /** `idle` means "nothing to do right now" as opposed to "this one failed". */
  | { ok: false; reason: string; retryable: boolean; idle: boolean };

/**
 * Send exactly one message. Every caller goes through here so the ledger row,
 * the header, the rate accounting, and the outcome bookkeeping cannot diverge.
 */
export async function sendOne(db: Db, draftId?: string): Promise<SendResult> {
  const sending = getSending();

  if (sentToday(db) >= sending.perDay) {
    return { ok: false, reason: 'Daily limit reached.', retryable: true, idle: true };
  }
  if (sentThisHour(db) >= sending.perHour) {
    return { ok: false, reason: 'Hourly limit reached.', retryable: true, idle: true };
  }

  const candidate = nextCandidate(db, draftId);
  if (!candidate) return { ok: false, reason: 'Nothing sendable in the queue.', retryable: false, idle: true };

  if (!(await gmail.isConnected())) {
    return { ok: false, reason: 'Gmail is not connected.', retryable: true, idle: true };
  }

  const sendId = ulid();
  tx(db, () => {
    run(
      db,
      `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      sendId,
      candidate.draftId,
      candidate.companyId,
      candidate.contactId,
      candidate.toEmail,
      candidate.subject,
      candidate.body,
      Date.now(),
    );
    run(db, `UPDATE draft SET state = 'sending', updated_at = ? WHERE id = ?`, Date.now(), candidate.draftId);
  });

  try {
    // The send id is the X-RecruitAI-Send-Id header, which is how a bounce DSN
    // or a reply gets matched back to this exact row.
    const result = await gmail.sendMessage({
      to: candidate.toEmail,
      subject: candidate.subject,
      body: candidate.body,
      sendId,
    });

    tx(db, () => {
      run(
        db,
        `UPDATE send SET gmail_id = ?, gmail_thread_id = ?, message_id = ?, sent_at = ?, outcome = 'sent', outcome_at = ?
          WHERE id = ?`,
        result.gmailId,
        result.threadId,
        result.messageId,
        result.sentAt,
        Date.now(),
        sendId,
      );
      run(db, `UPDATE draft SET state = 'sent', updated_at = ? WHERE id = ?`, Date.now(), candidate.draftId);
      run(
        db,
        `UPDATE contact SET status = 'contacted', updated_at = ? WHERE id = ? AND status IN ('candidate','approved')`,
        Date.now(),
        candidate.contactId,
      );
      auditLog(db, {
        actor: 'system',
        action: 'send',
        entity: 'send',
        entityId: sendId,
        after: { to: candidate.toEmail, subject: candidate.subject },
      });
    });

    emitEvent('data:changed', { entity: 'draft', id: candidate.draftId });
    emitSendProgress(db);
    return { ok: true, sendId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The gmail module re-checks suppression immediately before handing the
    // message to Google. If that check fires, the address must never be tried
    // again — skip the draft rather than leaving it retryable.
    const suppressed = err instanceof SuppressedRecipientError;

    tx(db, () => {
      run(
        db,
        `UPDATE send SET outcome = 'failed', outcome_at = ?, error = ? WHERE id = ?`,
        Date.now(),
        message.slice(0, 1000),
        sendId,
      );
      run(
        db,
        `UPDATE draft SET state = ?, scheduled_at = NULL, updated_at = ? WHERE id = ?`,
        suppressed ? 'skipped' : 'failed',
        Date.now(),
        candidate.draftId,
      );
    });

    if (/reauth|invalid_grant|unauthorized|\b401\b/i.test(message)) {
      emitEvent('gmail:needs-reauth', { address: gmail.getAddress() });
    }
    emitEvent('data:changed', { entity: 'draft', id: candidate.draftId });
    emitSendProgress(db);
    return { ok: false, reason: message, retryable: !suppressed, idle: false };
  }
}

function scheduleNextTick(db: Db, delayMs: number): void {
  if (sendTimer) clearTimeout(sendTimer);
  nextSendAt = Date.now() + delayMs;
  sendTimer = setTimeout(() => {
    void tick(db);
  }, delayMs);
  emitSendProgress(db);
}

async function tick(db: Db): Promise<void> {
  if (!sendingActive) return;

  if (!isInSendWindow()) {
    // Outside the window we idle cheaply rather than busy-checking.
    scheduleNextTick(db, 5 * 60_000);
    return;
  }

  const result = await sendOne(db);
  if (!result.ok && result.idle) {
    // Nothing to do right now. Stay armed so a newly-queued draft is picked up.
    scheduleNextTick(db, 60_000);
    return;
  }
  // A per-message failure shouldn't burn a whole pacing interval — move on to
  // the next candidate quickly, but not instantly.
  scheduleNextTick(db, result.ok ? jitteredIntervalMs() : 10_000);
}

export function startSending(db: Db): void {
  if (sendingActive) return;
  sendingActive = true;
  scheduleNextTick(db, 2_000);
}

export function pauseSending(db: Db): void {
  sendingActive = false;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = null;
  nextSendAt = null;
  emitSendProgress(db);
}

/**
 * A 'pending' send is a message we started and never confirmed. We do not know
 * whether it left, so it is marked failed and surfaced — never auto-retried.
 */
export function reconcileInterruptedSends(db: Db): number {
  const stale = all<{ id: string; draft_id: string }>(
    db,
    `SELECT id, draft_id FROM send WHERE outcome = 'pending' AND created_at < ?`,
    Date.now() - 10 * 60_000,
  );
  for (const s of stale) {
    tx(db, () => {
      run(
        db,
        `UPDATE send SET outcome = 'failed', outcome_at = ?, error = ? WHERE id = ?`,
        Date.now(),
        'Interrupted before Gmail confirmed delivery. Not resent automatically — check Gmail Sent before requeueing.',
        s.id,
      );
      run(db, `UPDATE draft SET state = 'failed', updated_at = ? WHERE id = ? AND state = 'sending'`, Date.now(), s.draft_id);
    });
  }
  return stale.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound
// ─────────────────────────────────────────────────────────────────────────────

interface InboundRowRaw extends Omit<InboundRow, 'handled'> {
  handled: number;
}

export function listInbound(db: Db, handled?: boolean): InboundRow[] {
  const where = handled === undefined ? '' : 'WHERE i.handled = ?';
  const args = handled === undefined ? [] : [handled ? 1 : 0];
  return all<InboundRowRaw>(
    db,
    `SELECT i.id, i.kind, i.from_email AS fromEmail, i.subject, i.snippet, i.received_at AS receivedAt,
            i.handled, s.company_id AS companyId, co.name AS companyName, s.contact_id AS contactId,
            i.send_id AS sendId, i.bounce_recipient AS bounceRecipient, i.bounce_status AS bounceStatus
       FROM inbound i
       LEFT JOIN send s ON s.id = i.send_id
       LEFT JOIN company co ON co.id = s.company_id
       ${where}
      ORDER BY i.received_at DESC
      LIMIT 500`,
    ...args,
  ).map((r) => ({ ...r, handled: r.handled === 1 }));
}

export function markInbound(db: Db, id: string, action: 'positive' | 'negative' | 'bounce' | 'ignore'): void {
  const row = get<{ send_id: string | null; from_email: string | null; bounce_recipient: string | null }>(
    db,
    'SELECT send_id, from_email, bounce_recipient FROM inbound WHERE id = ?',
    id,
  );
  if (!row) throw new Error(`Unknown inbound message: ${id}`);

  const send = row.send_id
    ? get<{ company_id: string; contact_id: string; to_email: string }>(
        db,
        'SELECT company_id, contact_id, to_email FROM send WHERE id = ?',
        row.send_id,
      )
    : null;

  tx(db, () => {
    switch (action) {
      case 'positive': {
        if (send) {
          run(db, `UPDATE send SET outcome = 'replied', outcome_at = ? WHERE id = ?`, Date.now(), row.send_id);
          run(db, `UPDATE contact SET status = 'replied', updated_at = ? WHERE id = ?`, Date.now(), send.contact_id);
        }
        break;
      }
      case 'negative': {
        if (send) {
          run(db, `UPDATE send SET outcome = 'replied', outcome_at = ? WHERE id = ?`, Date.now(), row.send_id);
          run(db, `UPDATE contact SET status = 'rejected', updated_at = ? WHERE id = ?`, Date.now(), send.contact_id);
          run(db, `UPDATE company SET status = 'rejected', updated_at = ? WHERE id = ?`, Date.now(), send.company_id);
          const domain = send.to_email.slice(send.to_email.indexOf('@') + 1);
          addSuppressionRow(db, 'domain', domain, 'replied_no', 'Asked not to be contacted again');
          // Anything still queued for this domain must not go out.
          cancelQueuedForDomain(db, domain);
        }
        break;
      }
      case 'bounce': {
        const address = (row.bounce_recipient ?? send?.to_email ?? '').trim().toLowerCase();
        if (send) {
          run(db, `UPDATE send SET outcome = 'bounced', outcome_at = ? WHERE id = ?`, Date.now(), row.send_id);
          run(
            db,
            `UPDATE contact SET status = 'bounced', email_verdict = 'invalid', updated_at = ? WHERE id = ?`,
            Date.now(),
            send.contact_id,
          );
        }
        if (address) {
          // A hard bounce is permanent — the address never becomes valid again.
          addSuppressionRow(db, 'email', address, 'bounced', 'Hard bounce');
          run(
            db,
            `UPDATE contact SET email_verdict = 'invalid', status = 'bounced', updated_at = ? WHERE lower(email) = ?`,
            Date.now(),
            address,
          );
        }
        break;
      }
      case 'ignore':
      default:
        break;
    }

    run(db, 'UPDATE inbound SET handled = 1 WHERE id = ?', id);
    auditLog(db, { actor: 'operator', action: `inbound:${action}`, entity: 'inbound', entityId: id });
  });

  if (send) recomputeCompany(db, send.company_id);
  emitEvent('data:changed', { entity: 'inbound', id });
  emitSendProgress(db);
}

function cancelQueuedForDomain(db: Db, domain: string): void {
  run(
    db,
    `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
      WHERE state IN ('draft','queued')
        AND contact_id IN (SELECT id FROM contact WHERE lower(substr(email, instr(email, '@') + 1)) = lower(?))`,
    Date.now(),
    domain,
  );
}

export function addSuppressionRow(db: Db, kind: string, value: string, reason: string, note: string | null): void {
  run(
    db,
    `INSERT INTO suppression (kind, value, reason, note, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, value) DO NOTHING`,
    kind,
    value.trim().toLowerCase(),
    reason,
    note,
    Date.now(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerOutreachIpc(): void {
  ipcMain.handle('listDrafts', async (_e, state?: string) => listDrafts(getDb(), state || undefined));

  ipcMain.handle('generateDraft', async (_e, companyId: string, contactId?: string) => {
    const db = getDb();
    try {
      const generated = await generateDraftFor(db, companyId, contactId || undefined, { force: true });
      emitEvent('data:changed', { entity: 'draft', id: generated.id });
      return readDraft(db, generated.id);
    } catch (err) {
      if (err instanceof DraftNotPossible) throw new Error(err.message);
      throw err;
    }
  });

  ipcMain.handle('patchDraft', async (_e, id: string, patch: { subject?: string; body?: string }) =>
    patchDraft(getDb(), id, patch ?? {}),
  );

  ipcMain.handle('queueDraft', async (_e, id: string) => {
    queueDraft(getDb(), id);
  });

  ipcMain.handle('skipDraft', async (_e, id: string) => {
    skipDraft(getDb(), id);
  });

  ipcMain.handle('sendNow', async (_e, id: string) => {
    const db = getDb();
    const state = get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', id);
    if (!state) throw new Error(`Unknown draft: ${id}`);
    if (state.state === 'draft' || state.state === 'failed') queueDraft(db, id);

    const result = await sendOne(db, id);
    if (!result.ok) throw new Error(result.reason);
  });

  ipcMain.handle('getSendStats', async () => getSendStats(getDb()));

  ipcMain.handle('startSending', async () => {
    startSending(getDb());
  });

  ipcMain.handle('pauseSending', async () => {
    pauseSending(getDb());
  });

  ipcMain.handle('listInbound', async (_e, handled?: boolean) =>
    listInbound(getDb(), typeof handled === 'boolean' ? handled : undefined),
  );

  ipcMain.handle('markInbound', async (_e, id: string, action: 'positive' | 'negative' | 'bounce' | 'ignore') => {
    markInbound(getDb(), id, action);
  });

  ipcMain.handle('syncInbox', async () => {
    const count = await gmail.syncInbox();
    emitEvent('data:changed', { entity: 'inbound' });
    return typeof count === 'number' ? count : 0;
  });
}
