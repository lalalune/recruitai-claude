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

import { handle } from './guard.js';
import { getDb, all, get, run, tx, ulid, type Db } from '../db/index.js';
import { getSending } from '../settings.js';
import { emitEvent, appendLog } from '../pipeline/run.js';
import { generateDraftFor, followUpDraftFor, DraftNotPossible } from '../pipeline/drafts.js';
import { recomputeCompany } from '../pipeline/scoring.js';
import { auditLog } from './companies.js';
import * as gmail from '../gmail/index.js';
import { SuppressedRecipientError } from '../gmail/send.js';
import { GmailAuthError, GmailQuotaError } from '../gmail/oauth.js';
import { isFreemailDomain } from '../verify/mx.js';
import { companySuppressionValues, COMPANY_SUPPRESSION_MATCH } from '../pipeline/suppression.js';
import { ensureCompliantFooter } from '../../shared/outreach.js';
import type { DraftRow, InboundRow, PerformanceRow, SendStats, SentRow } from '../../shared/ipc.js';
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
        OR (s.kind = 'company' AND ${COMPANY_SUPPRESSION_MATCH})
  )
  -- Never email someone whose reply the operator has not read yet. Sending is
  -- automated; opt-out intake is human — this is the bridge between the two.
  AND NOT EXISTS (
    SELECT 1 FROM inbound i JOIN send s2 ON s2.id = i.send_id
     WHERE s2.contact_id = c.id AND i.handled = 0
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
/** Return a queued draft to Drafts — the honest inverse of queueDraft. */
export function unqueueDraft(db: Db, id: string): void {
  const res = run(
    db,
    `UPDATE draft SET state = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ? AND state = 'queued'`,
    Date.now(),
    id,
  );
  if (Number(res.changes) === 0) {
    throw new Error('Only a queued draft can be returned to Drafts.');
  }
  auditLog(db, { actor: 'operator', action: 'unqueueDraft', entity: 'draft', entityId: id });
  emitEvent('data:changed', { entity: 'draft', id });
  emitSendProgress(db);
}

/**
 * Send the draft's exact content to the operator's own address, subject
 * prefixed [TEST]. No send row, no pacing charge, no contact touched — this
 * is how the operator checks rendering and spam placement before real sends.
 */
export async function sendTestEmail(db: Db, id: string): Promise<string> {
  const draft = readDraft(db, id);
  if (!(await gateway.isConnected())) throw new Error('Gmail is not connected.');
  const address = gateway.getAddress();
  if (!address) {
    throw new Error('The connected address is unknown — run "Test connection" in Settings first.');
  }
  // Same footer backstop as the real send path — a test that exercises a
  // different message than the one that will leave is not a test.
  const sending = getSending();
  const body = ensureCompliantFooter(draft.body, {
    includeOptOutLine: sending.includeOptOutLine,
    postalAddress: sending.postalAddress,
  });
  await gateway.sendMessage({
    to: address,
    subject: `[TEST] ${draft.subject}`,
    body,
    sendId: `test-${ulid()}`,
  });
  auditLog(db, { actor: 'operator', action: 'sendTestEmail', entity: 'draft', entityId: id, after: { to: address } });
  return address;
}

interface SentRowRaw {
  sendId: string;
  draftId: string;
  companyId: string;
  companyName: string;
  contactId: string;
  contactName: string;
  toEmail: string;
  subject: string;
  sentAt: number | null;
  outcome: SentRow['outcome'];
  isFollowUp: number;
  hasActiveFollowUp: number;
}

/** Sent messages with outcomes, newest first — the follow-up work surface. */
export function listSent(db: Db): SentRow[] {
  return all<SentRowRaw>(
    db,
    `SELECT s.id AS sendId, s.draft_id AS draftId, s.company_id AS companyId, co.name AS companyName,
            s.contact_id AS contactId, c.full_name AS contactName, s.to_email AS toEmail, s.subject,
            s.sent_at AS sentAt, s.outcome,
            (d.follow_up_of IS NOT NULL) AS isFollowUp,
            EXISTS (SELECT 1 FROM draft f WHERE f.follow_up_of = s.id AND f.state IN ('draft','queued','sending','failed')) AS hasActiveFollowUp
       FROM send s
       JOIN company co ON co.id = s.company_id
       JOIN contact c ON c.id = s.contact_id
       JOIN draft d ON d.id = s.draft_id
      WHERE s.outcome IN ('sent','silent','replied','bounced')
      ORDER BY s.sent_at IS NULL, s.sent_at DESC, s.created_at DESC
      LIMIT 500`,
  ).map((r) => ({ ...r, isFollowUp: r.isFollowUp === 1, hasActiveFollowUp: r.hasActiveFollowUp === 1 }));
}

/**
 * Reply/bounce rates by template band and copy kind. This is the whole
 * copy-iteration loop: every send already records which band and which kind
 * of copy (built-in, operator template, follow-up bump) produced it, so
 * "which copy works" is one GROUP BY away instead of a guess.
 */
export function getPerformance(db: Db): PerformanceRow[] {
  const rows = all<{ band: string | null; kind: string; sent: number; replied: number; bounced: number }>(
    db,
    `SELECT COALESCE(d.template, 'unknown') AS band,
            CASE WHEN d.generated_by LIKE 'followup%' THEN 'follow_up'
                 WHEN d.generated_by LIKE 'custom%'   THEN 'custom'
                 ELSE 'builtin' END AS kind,
            count(*) AS sent,
            COALESCE(sum(CASE WHEN s.outcome = 'replied' THEN 1 ELSE 0 END), 0) AS replied,
            COALESCE(sum(CASE WHEN s.outcome = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced
       FROM send s
       JOIN draft d ON d.id = s.draft_id
      WHERE s.outcome IN ('sent','silent','replied','bounced')
      GROUP BY band, kind
      ORDER BY sent DESC`,
  );
  return rows.map((r) => ({
    band: r.band ?? 'unknown',
    kind: (r.kind as PerformanceRow['kind']) ?? 'builtin',
    sent: r.sent,
    replied: r.replied,
    bounced: r.bounced,
    replyRate: r.sent > 0 ? r.replied / r.sent : 0,
  }));
}

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

  try {
    run(db, `UPDATE draft SET state = 'queued', scheduled_at = ?, updated_at = ? WHERE id = ?`, nextSlot(db), Date.now(), id);
  } catch (err) {
    // Requeueing a failed draft can collide with a newer active draft for the
    // same person on the active-only unique index.
    if (err instanceof Error && /UNIQUE constraint failed: draft\.contact_id/.test(err.message)) {
      throw new Error('Another draft for this person is already active — skip one of them first.');
    }
    throw err;
  }
  auditLog(db, { actor: 'operator', action: 'queueDraft', entity: 'draft', entityId: id });
  emitEvent('data:changed', { entity: 'draft', id });
  emitSendProgress(db);
}

export function skipDraft(db: Db, id: string): void {
  // State-guarded: skipping a 'sending' draft would race the in-flight Gmail
  // call (whose failure path re-queues), and skipping a 'sent' one rewrites
  // history. Neither is a skip.
  const res = run(
    db,
    `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ? WHERE id = ? AND state IN ('draft','queued','failed')`,
    Date.now(),
    id,
  );
  if (Number(res.changes) === 0) {
    const row = get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', id);
    throw new Error(
      row ? `A ${row.state} draft cannot be skipped.` : `Unknown draft: ${id}`,
    );
  }
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
  /** The send this draft follows up on, when it is a bump. */
  followUpOf: string | null;
}

function nextCandidate(db: Db, draftId?: string): SendCandidate | null {
  const extra = draftId ? 'AND d.id = ?' : '';
  const args = draftId ? [draftId] : [];
  const row = get<SendCandidate>(
    db,
    `SELECT d.id AS draftId, d.company_id AS companyId, d.contact_id AS contactId,
            c.email AS toEmail, d.subject, d.body, d.follow_up_of AS followUpOf
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

/**
 * The Gmail surface sendOne/sendTestEmail actually touch. Injectable for tests
 * (precedent: inbox.ts clientFactory) — the send path is the one place a test
 * must never hit the real network, and it previously had zero direct coverage
 * for exactly that reason. Production never swaps it.
 */
export interface SendGateway {
  isConnected(): Promise<boolean>;
  getAddress(): string | null;
  sendMessage: typeof gmail.sendMessage;
}

let gateway: SendGateway = gmail;

export function __setSendGatewayForTests(g: SendGateway | null): void {
  gateway = g ?? gmail;
}

export type SendResult =
  | { ok: true; sendId: string }
  /**
   * `idle` means "nothing to do right now" as opposed to "this one failed".
   * `pause` means the failure is transport-wide (quota, auth) — the queue must
   * stop rather than burn every remaining draft against a dead API.
   */
  | { ok: false; reason: string; retryable: boolean; idle: boolean; pause?: boolean };

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

  // Deliverability circuit breaker: a run of bounces means the list quality
  // or the account's standing has a problem, and every further send makes the
  // sender reputation worse. Trip → pause; the operator investigates.
  const recent = get<{ total: number; bounced: number }>(
    db,
    `SELECT count(*) AS total, COALESCE(sum(CASE WHEN outcome = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced
       FROM (SELECT outcome FROM send WHERE outcome IN ('sent','silent','replied','bounced')
             ORDER BY created_at DESC LIMIT 50)`,
  );
  if (recent && recent.total >= 10 && recent.bounced >= 3 && recent.bounced / recent.total >= 0.1) {
    return {
      ok: false,
      reason: `Bounce circuit breaker: ${recent.bounced} of the last ${recent.total} sends bounced. Verify your list before resuming.`,
      retryable: false,
      idle: false,
      pause: true,
    };
  }

  // Connectivity first: after this point there are no awaits until the draft
  // is claimed, so two overlapping calls cannot both pass the claim below.
  if (!(await gateway.isConnected())) {
    return { ok: false, reason: 'Gmail is not connected.', retryable: true, idle: true };
  }

  const candidate = nextCandidate(db, draftId);
  if (!candidate) return { ok: false, reason: 'Nothing sendable in the queue.', retryable: false, idle: true };

  // Atomic claim: only the caller that actually flips queued → sending owns
  // this draft. The armed timer and an operator's Send-now can otherwise pick
  // the same head-of-queue row and the same person gets the email twice.
  const sendId = ulid();
  let claimed = false;
  tx(db, () => {
    const res = run(
      db,
      `UPDATE draft SET state = 'sending', updated_at = ? WHERE id = ? AND state = 'queued'`,
      Date.now(),
      candidate.draftId,
    );
    if (Number(res.changes) === 0) return;
    claimed = true;
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
  });
  if (!claimed) {
    return { ok: false, reason: 'Draft is already being sent.', retryable: true, idle: true };
  }

  try {
    // Send-time compliance backstop: however the draft was edited after
    // generation, the message that leaves carries the opt-out line and the
    // postal address whenever they are configured on.
    const finalBody = ensureCompliantFooter(candidate.body, {
      includeOptOutLine: sending.includeOptOutLine,
      postalAddress: sending.postalAddress,
    });
    if (finalBody !== candidate.body) {
      run(db, `UPDATE send SET body = ? WHERE id = ?`, finalBody, sendId);
    }

    // A follow-up threads onto the original send: same Gmail thread, proper
    // In-Reply-To/References so the recipient's client stacks it correctly.
    let threading: { threadId?: string; inReplyTo?: string; references?: string[] } = {};
    if (candidate.followUpOf) {
      const orig = get<{ gmail_thread_id: string | null; message_id: string | null }>(
        db,
        'SELECT gmail_thread_id, message_id FROM send WHERE id = ?',
        candidate.followUpOf,
      );
      threading = {
        threadId: orig?.gmail_thread_id ?? undefined,
        inReplyTo: orig?.message_id ?? undefined,
        references: orig?.message_id ? [orig.message_id] : undefined,
      };
    }

    // The send id is the X-RecruitAI-Send-Id header, which is how a bounce DSN
    // or a reply gets matched back to this exact row.
    const result = await gateway.sendMessage({
      to: candidate.toEmail,
      subject: candidate.subject,
      body: finalBody,
      sendId,
      companyId: candidate.companyId,
      ...threading,
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
    // Quota, auth, and NETWORK failures are transport-wide, not the draft's
    // fault: the draft goes back to the queue untouched and the caller pauses
    // the run. Without the offline leg, a dropped Wi-Fi connection burned the
    // whole queue to 'failed' at one draft per 10-second tick.
    const offline = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|network|fetch failed/i.test(message);
    const transport = err instanceof GmailQuotaError || err instanceof GmailAuthError || offline;

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
        suppressed ? 'skipped' : transport ? 'queued' : 'failed',
        Date.now(),
        candidate.draftId,
      );
    });

    if (err instanceof GmailAuthError || /reauth|invalid_grant|unauthorized|\b401\b/i.test(message)) {
      emitEvent('gmail:needs-reauth', { address: gmail.getAddress() });
    }
    emitEvent('data:changed', { entity: 'draft', id: candidate.draftId });
    emitSendProgress(db);
    return { ok: false, reason: message, retryable: !suppressed, idle: false, pause: transport };
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

/** While the queue runs, pull the inbox on a timer so an unread "stop" reply
 *  blocks that contact (see SENDABLE_PREDICATE) without waiting for a manual
 *  sync. Failures are logged and never stall the queue. */
const AUTO_SYNC_EVERY_MS = 15 * 60_000;
let lastAutoInboxSyncAt = 0;

async function tick(db: Db): Promise<void> {
  if (!sendingActive) return;

  if (!isInSendWindow()) {
    // Outside the window we idle cheaply rather than busy-checking.
    scheduleNextTick(db, 5 * 60_000);
    return;
  }

  if (Date.now() - lastAutoInboxSyncAt > AUTO_SYNC_EVERY_MS) {
    lastAutoInboxSyncAt = Date.now();
    try {
      const n = await gmail.syncInbox();
      if (typeof n === 'number' && n > 0) emitEvent('data:changed', { entity: 'inbound' });
    } catch (err) {
      appendLog('sender', 'warn', `Inbox auto-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The operator may have hit Pause during the sync await — re-check before
  // committing a send, and again after it so a paused run never re-arms.
  if (!sendingActive) return;

  const result = await sendOne(db);
  if (!sendingActive) return;
  if (!result.ok && result.pause) {
    // Gmail said stop (quota or auth). Keep the queue intact and stand down —
    // ticking on would burn every remaining draft against a dead API.
    appendLog('sender', 'error', `Sending paused: ${result.reason}`);
    pauseSending(db);
    return;
  }
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
 *
 * Runs at startup only. The single-instance lock in src/main/index.ts means no
 * other process can be mid-send, so every pending row is an orphan regardless
 * of age — an age floor here just left crash-then-quick-relaunch drafts wedged
 * in 'sending' until some later restart.
 */
export function reconcileInterruptedSends(db: Db): number {
  const stale = all<{ id: string; draft_id: string }>(
    db,
    `SELECT id, draft_id FROM send WHERE outcome = 'pending'`,
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
          const address = send.to_email.trim().toLowerCase();
          const domain = address.slice(address.indexOf('@') + 1);
          if (isFreemailDomain(domain)) {
            // One founder on gmail.com saying "no" must not suppress every
            // gmail.com contact in the pipeline — suppress the address only.
            addSuppressionRow(db, 'email', address, 'replied_no', 'Asked not to be contacted again');
            cancelQueuedForEmail(db, address);
          } else {
            addSuppressionRow(db, 'domain', domain, 'replied_no', 'Asked not to be contacted again');
            // Anything still queued for this domain must not go out.
            cancelQueuedForDomain(db, domain);
          }
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
          // Queued drafts to a dead address can never send (the predicate
          // excludes them) — pull them so the Queue stops showing zombies.
          cancelQueuedForEmail(db, address);
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
  // The transaction above may have rejected the company, suppressed an
  // identity, and skipped queued drafts — every one of those surfaces reads
  // stale without its own event (the Review list is staleTime-Infinity).
  // Not gated on `send`: an UNMATCHED bounce still suppresses the recipient
  // address and flips contacts.
  if (action === 'negative' || action === 'bounce') {
    emitEvent('data:changed', { entity: 'company' });
    emitEvent('data:changed', { entity: 'draft' });
    emitEvent('data:changed', { entity: 'suppression' });
  }
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

function cancelQueuedForEmail(db: Db, address: string): void {
  run(
    db,
    `UPDATE draft SET state = 'skipped', scheduled_at = NULL, updated_at = ?
      WHERE state IN ('draft','queued')
        AND contact_id IN (SELECT id FROM contact WHERE lower(email) = lower(?))`,
    Date.now(),
    address,
  );
}

export function addSuppressionRow(db: Db, kind: string, value: string, reason: string, note: string | null): void {
  // Company values are canonicalised (ULID / domain / normName), preferring
  // the reading that matches a real company — "Node.js" is a NAME whose
  // norm is 'node js', not the domain 'node.js'. A pre-emptive entry that
  // matches nothing yet stores BOTH readings. Everything else lowercases.
  const values = kind === 'company' ? companySuppressionValues(db, value) : [value.trim().toLowerCase()];
  for (const stored of values) {
    run(
      db,
      `INSERT INTO suppression (kind, value, reason, note, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, value) DO NOTHING`,
      kind,
      stored,
      reason,
      note,
      Date.now(),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerOutreachIpc(): void {
  handle('listDrafts', async (state?: string) => listDrafts(getDb(), state));

  handle('generateDraft', async (companyId: string, contactId?: string, force?: boolean) => {
    const db = getDb();
    try {
      // force is ONLY the explicit Regenerate button. A plain compose keeps
      // the guards live: edited drafts survive, and an already-emailed person
      // routes to the follow-up flow instead of a second cold pitch.
      const generated = await generateDraftFor(db, companyId, contactId, { force: force === true });
      emitEvent('data:changed', { entity: 'draft', id: generated.id });
      return readDraft(db, generated.id);
    } catch (err) {
      if (err instanceof DraftNotPossible) throw new Error(err.message);
      throw err;
    }
  });

  handle('patchDraft', async (id: string, patch: { subject?: string; body?: string }) =>
    patchDraft(getDb(), id, patch),
  );

  handle('queueDraft', async (id: string) => {
    queueDraft(getDb(), id);
  });

  handle('unqueueDraft', async (id: string) => {
    unqueueDraft(getDb(), id);
  });

  handle('skipDraft', async (id: string) => {
    skipDraft(getDb(), id);
  });

  handle('sendTestEmail', async (id: string) => sendTestEmail(getDb(), id));

  handle('listSent', async () => listSent(getDb()));

  handle('getPerformance', async () => getPerformance(getDb()));

  handle('generateFollowUp', async (sendId: string) => {
    const db = getDb();
    try {
      const generated = await followUpDraftFor(db, sendId);
      emitEvent('data:changed', { entity: 'draft', id: generated.id });
      return readDraft(db, generated.id);
    } catch (err) {
      if (err instanceof DraftNotPossible) throw new Error(err.message);
      throw err;
    }
  });

  handle('sendNow', async (id: string) => {
    const db = getDb();
    const state = get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', id);
    if (!state) throw new Error(`Unknown draft: ${id}`);
    if (state.state === 'sent' || state.state === 'sending' || state.state === 'skipped') {
      throw new Error(`This draft is ${state.state} — nothing to send.`);
    }
    if (state.state === 'draft' || state.state === 'failed') queueDraft(db, id);

    const result = await sendOne(db, id);
    if (!result.ok) {
      // A quota/auth/offline error discovered via Send-now must stop the armed
      // timer too — otherwise it rediscovers the same error one tick later.
      if (result.pause) pauseSending(db);
      throw new Error(result.reason);
    }
  });

  handle('getSendStats', async () => getSendStats(getDb()));

  handle('startSending', async () => {
    startSending(getDb());
  });

  handle('pauseSending', async () => {
    pauseSending(getDb());
  });

  handle('listInbound', async (handled?: boolean) => listInbound(getDb(), handled));

  handle('markInbound', async (id: string, action: 'positive' | 'negative' | 'bounce' | 'ignore') => {
    markInbound(getDb(), id, action);
  });

  handle('syncInbox', async () => {
    const count = await gmail.syncInbox();
    emitEvent('data:changed', { entity: 'inbound' });
    return typeof count === 'number' ? count : 0;
  });
}
