/**
 * Inbox sync — polling, not Pub/Sub.
 *
 * Pub/Sub push needs a publicly reachable HTTPS endpoint, which a desktop app
 * does not have. users.history.list costs 2 quota units against a daily budget
 * of 80,000,000, so polling every few minutes is free in practice and removes an
 * entire class of infrastructure.
 *
 * On attribution, honestly: it is best-effort. RFC 3464 makes the third MIME
 * part of a DSN — the returned original headers, and therefore our
 * X-RecruitAI-Send-Id — OPTIONAL, and plenty of MTAs omit it. So this walks a
 * ranked chain (custom header → Gmail thread id → Final-Recipient address) and
 * accepts that some bounces will land unattributed. The dominant outcome is not
 * a bounce at all: spam filters that accept-then-discard produce no DSN, which
 * is what the 'silent' outcome exists to represent.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { gmail_v1 } from '@googleapis/gmail';
import { getDb, prep, ulid } from '../db/index.js';
import {
  getGmailClient,
  gmailCall,
  isConnected,
  getSetting,
  setSetting,
  emitGmailEvent,
  GmailApiError,
  GmailAuthError,
  GmailQuotaError,
  KEY_HISTORY_ID,
} from './oauth.js';
import {
  SEND_ID_HEADER,
  flattenParts,
  decodePartBody,
  findPart,
  headerValue,
  hasHeader,
  parseContentType,
  parseHeaderBlock,
  parseDeliveryStatus,
  extractAddress,
  extractMessageId,
  extractMessageIds,
  type DeliveryStatusRecipient,
} from './mime.js';

/** Ceiling on messages examined in one sync, so a long absence can't stall the UI. */
const MAX_MESSAGES_PER_SYNC = 500;
/** Fallback lookback bounds when the stored historyId has expired. */
const MIN_FALLBACK_DAYS = 3;
const MAX_FALLBACK_DAYS = 30;
const DEFAULT_FALLBACK_DAYS = 14;
/** After this long with no DSN and no reply, a send is classified 'silent'. */
const SILENT_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

type InboundKind = 'reply' | 'bounce' | 'auto_reply' | 'unmatched';

interface Classification {
  kind: InboundKind;
  sendId: string | null;
  bounceRecipient: string | null;
  bounceStatus: string | null;
  /** True only for Action: failed / 5.x.x — a delay warning must not kill a send. */
  permanentFailure: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function syncInbox(
  // Injectable for tests; production callers take the default. The seam exists
  // because the historyId resume semantics below are exactly the kind of logic
  // that only ever goes wrong against a mailbox with more mail than a fixture.
  clientFactory: () => Promise<gmail_v1.Gmail> = getGmailClient,
): Promise<number> {
  if (!(await isConnected())) throw new GmailAuthError('Gmail is not connected.');

  const api = await clientFactory();
  const stored = getSetting(KEY_HISTORY_ID);

  let ids: string[] = [];
  let nextHistoryId: string | null = null;
  let scanComplete = false;

  if (stored) {
    const incremental = await listIncremental(api, stored);
    if (incremental) {
      ids = incremental.ids;
      nextHistoryId = incremental.historyId;
    }
  }

  if (!nextHistoryId) {
    // Either first run, or Gmail 404'd an expired historyId. Either way, a
    // date-bounded search is the documented recovery.
    const scan = await listByQuery(api);
    ids = scan.ids;
    scanComplete = scan.complete;
  }

  const fresh = dedupe(ids).filter((id) => !alreadyStored(id));
  const batch = fresh.slice(0, MAX_MESSAGES_PER_SYNC);

  // INVARIANT: a historyId is persisted only when every message at or before it
  // has been examined this sync or in a previous one. The slice above is the
  // last place that can silently break that — if it cut anything, persist
  // nothing; the next sync re-lists the same range, alreadyStored() makes the
  // overlap idempotent, and each pass advances by a full batch.
  const cutByCap = batch.length < fresh.length;

  if (!nextHistoryId && scanComplete && !cutByCap) {
    // The fallback scan drained its whole window, so "everything up to now is
    // covered" is genuinely true and the current mailbox historyId is a sound
    // anchor for incremental sync to resume from.
    const profile = await gmailCall(() => api.users.getProfile({ userId: 'me' }));
    nextHistoryId = profile.data.historyId ?? null;
  }
  // A truncated fallback scan persists nothing on purpose: messages.list is a
  // search with no resumable cursor, and anchoring at "now" would declare the
  // unlisted remainder synced. Leaving the stored value untouched (absent, or
  // expired) sends the next sync straight back here, where the filter above
  // skips this batch and the scan advances. The cost when the stored id has
  // expired is one 404'd history.list per pass — two quota units against the
  // eighty-million-per-day budget described at the top of this file.

  const messages = await fetchMessages(api, batch);

  let inserted = 0;
  for (const msg of messages) {
    if (shouldSkip(msg)) continue;
    if (persist(msg)) inserted++;
  }

  if (nextHistoryId && !cutByCap) setSetting(KEY_HISTORY_ID, nextHistoryId);
  markSilentSends();

  if (inserted > 0) emitGmailEvent('data:changed', { entity: 'inbound' });
  return inserted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────

async function listIncremental(
  api: gmail_v1.Gmail,
  startHistoryId: string,
): Promise<{ ids: string[]; historyId: string } | null> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  // The anchor the next sync resumes from. It advances in two distinct ways:
  // past each history record whose messages are all in `ids` (records carry
  // their own mailbox sequence id), and to the response-level historyId only
  // once the listing is fully drained. The response-level id is the mailbox's
  // CURRENT position — persisting it after a truncated listing would skip
  // every record between the cap and "now" forever.
  let historyId = startHistoryId;
  let capped = false;

  try {
    do {
      const res = await gmailCall(() =>
        api.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
          maxResults: 500,
          pageToken,
        }),
      );

      for (const record of res.data.history ?? []) {
        const added = (record.messagesAdded ?? [])
          .map((m) => m.message?.id)
          .filter((id): id is string => Boolean(id));
        // Stop BEFORE a record that would blow the budget: the anchor only
        // ever moves over records whose messages were all collected, so the
        // downstream batch cap can never orphan a message behind it. (The
        // ids.length guard takes a single record larger than the whole budget
        // in one gulp — oversized is recoverable, stalling forever is not.)
        if (ids.length > 0 && ids.length + added.length > MAX_MESSAGES_PER_SYNC) {
          capped = true;
          break;
        }
        ids.push(...added);
        if (record.id) historyId = record.id;
      }
      if (capped) break;

      pageToken = res.data.nextPageToken ?? undefined;
      // Fully drained — now, and only now, the response-level historyId is a
      // truthful "caught up to here", and it also keeps the anchor fresh on
      // quiet days when no records arrive at all.
      if (!pageToken && res.data.historyId) historyId = res.data.historyId;
    } while (pageToken && ids.length < MAX_MESSAGES_PER_SYNC);

    return { ids, historyId };
  } catch (err) {
    // Documented behaviour: an expired historyId is a hard 404, not an empty
    // result. Anything else is a real failure and must propagate.
    if (err instanceof GmailApiError && err.status === 404) {
      console.warn('[gmail] stored historyId expired; falling back to a date-bounded search');
      return null;
    }
    throw err;
  }
}

async function listByQuery(
  api: gmail_v1.Gmail,
): Promise<{ ids: string[]; complete: boolean }> {
  const days = fallbackWindowDays();
  const q = `newer_than:${days}d -in:sent -in:draft -in:chats`;
  const ids: string[] = [];
  // FRESH ids gate the cap, not listed ids: the search always restarts from
  // the newest message, so counting raw listings meant a window holding more
  // than one cap of already-stored mail re-listed the same newest batch every
  // pass and never reached the older remainder — the scan stalled forever
  // while looking healthy.
  let freshCount = 0;
  let pageToken: string | undefined;

  do {
    const res = await gmailCall(() =>
      api.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken }),
    );
    for (const m of res.data.messages ?? []) {
      if (!m.id) continue;
      ids.push(m.id);
      if (!alreadyStored(m.id)) freshCount++;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && freshCount < MAX_MESSAGES_PER_SYNC);

  // A leftover pageToken means an unknown remainder was never listed, and the
  // caller must not treat this scan as a complete picture of the window.
  return { ids, complete: !pageToken };
}

/** Reach back far enough to cover the oldest send still awaiting an outcome. */
function fallbackWindowDays(): number {
  const row = prep(
    getDb(),
    `SELECT min(sent_at) AS oldest FROM send
      WHERE sent_at IS NOT NULL AND outcome IN ('pending', 'sent')`,
  ).get() as { oldest: number | null } | undefined;

  if (!row?.oldest) return DEFAULT_FALLBACK_DAYS;
  const days = Math.ceil((Date.now() - row.oldest) / DAY_MS) + 1;
  return Math.min(MAX_FALLBACK_DAYS, Math.max(MIN_FALLBACK_DAYS, days));
}

/**
 * Bounded concurrency, but a quota or auth failure aborts the whole sync rather
 * than being logged per-message. Continuing to hammer an endpoint that just told
 * us to stop is exactly the behaviour the project rules forbid.
 */
async function fetchMessages(
  api: gmail_v1.Gmail,
  ids: string[],
): Promise<gmail_v1.Schema$Message[]> {
  const out: gmail_v1.Schema$Message[] = [];
  let cursor = 0;
  let fatal: unknown = null;

  const workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (fatal === null) {
      const index = cursor++;
      if (index >= ids.length) return;
      const id = ids[index]!;
      try {
        const res = await gmailCall(() =>
          api.users.messages.get({ userId: 'me', id, format: 'full' }),
        );
        out.push(res.data);
      } catch (err) {
        if (err instanceof GmailQuotaError || err instanceof GmailAuthError) {
          fatal = err;
          return;
        }
        console.warn(`[gmail] could not fetch message ${id}:`, err);
      }
    }
  });

  await Promise.all(workers);
  if (fatal) throw fatal;
  return out;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function alreadyStored(gmailId: string): boolean {
  return prep(getDb(), 'SELECT 1 FROM inbound WHERE gmail_id = ?').get(gmailId) !== undefined;
}

/** Our own outbound copies come back through history; they are not inbound mail. */
function shouldSkip(msg: gmail_v1.Schema$Message): boolean {
  const labels = msg.labelIds ?? [];
  return labels.includes('SENT') || labels.includes('DRAFT') || labels.includes('CHAT');
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

const AUTOREPLY_SUBJECT = /^\s*(re:\s*)?(out of office|automatic reply|auto:|autoreply|automated response)/i;

function classify(msg: gmail_v1.Schema$Message): Classification {
  const headers = msg.payload?.headers ?? [];
  const parts = flattenParts(msg.payload ?? undefined);
  const fromEmail = extractAddress(headerValue(headers, 'From'));

  if (isDeliveryStatusNotification(headers, parts, fromEmail)) {
    return classifyBounce(msg, parts, headers);
  }

  const sendId = matchReply(msg, headers, fromEmail);

  if (isAutoReply(headers, msg)) {
    return { kind: 'auto_reply', sendId, bounceRecipient: null, bounceStatus: null, permanentFailure: false };
  }

  return {
    kind: sendId ? 'reply' : 'unmatched',
    sendId,
    bounceRecipient: null,
    bounceStatus: null,
    permanentFailure: false,
  };
}

function isDeliveryStatusNotification(
  headers: { name?: string | null; value?: string | null }[],
  parts: gmail_v1.Schema$MessagePart[],
  fromEmail: string | null,
): boolean {
  const ct = parseContentType(headerValue(headers, 'Content-Type'));
  if (ct.type === 'multipart/report' && ct.params['report-type'] === 'delivery-status') return true;
  if (findPart(parts, 'message/delivery-status')) return true;

  const local = fromEmail?.split('@')[0] ?? '';
  return local === 'mailer-daemon' || local === 'postmaster';
}

function classifyBounce(
  msg: gmail_v1.Schema$Message,
  parts: gmail_v1.Schema$MessagePart[],
  headers: { name?: string | null; value?: string | null }[],
): Classification {
  const dsPart = findPart(parts, 'message/delivery-status');
  const recipients = dsPart ? parseDeliveryStatus(decodePartBody(dsPart)) : [];

  const failed = recipients.find((r) => r.action === 'failed');
  const chosen = failed ?? recipients[0] ?? null;
  const status = chosen?.status ?? statusFromDiagnostic(chosen) ?? null;
  const recipient = chosen?.finalRecipient ?? chosen?.originalRecipient ?? null;
  const permanentFailure = Boolean(failed) || (status?.startsWith('5') ?? false);

  const sendId =
    sendIdFromReturnedHeaders(parts, headers) ??
    sendIdFromThread(msg.threadId ?? null) ??
    sendIdFromRecipient(recipient);

  return { kind: 'bounce', sendId, bounceRecipient: recipient, bounceStatus: status, permanentFailure };
}

function statusFromDiagnostic(r: DeliveryStatusRecipient | null): string | null {
  if (!r?.diagnosticCode) return null;
  const m = r.diagnosticCode.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/);
  return m ? m[1]! : null;
}

/**
 * Rank 1. Present only when the reporting MTA chose to return the original
 * headers — RFC 3464 says it MAY, so this misses often enough that the fallback
 * ranks below are not decoration.
 */
function sendIdFromReturnedHeaders(
  parts: gmail_v1.Schema$MessagePart[],
  topHeaders: { name?: string | null; value?: string | null }[],
): string | null {
  const direct = headerValue(topHeaders, SEND_ID_HEADER);
  if (direct && sendExists(direct)) return direct;

  for (const part of parts) {
    const mime = (part.mimeType ?? '').toLowerCase();
    if (mime !== 'text/rfc822-headers' && mime !== 'message/rfc822') continue;

    const nested = headerValue(part.headers, SEND_ID_HEADER);
    if (nested && sendExists(nested)) return nested;

    const body = decodePartBody(part);
    if (!body) continue;
    const value = headerValue(parseHeaderBlock(body), SEND_ID_HEADER);
    if (value && sendExists(value)) return value;
  }
  return null;
}

/** Rank 2. Gmail usually threads a DSN with the message that caused it. */
function sendIdFromThread(threadId: string | null): string | null {
  if (!threadId) return null;
  const row = prep(
    getDb(),
    'SELECT id FROM send WHERE gmail_thread_id = ? ORDER BY sent_at DESC LIMIT 1',
  ).get(threadId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Rank 3. Most recent still-unresolved send to that address wins. */
function sendIdFromRecipient(email: string | null): string | null {
  if (!email) return null;
  const row = prep(
    getDb(),
    `SELECT id FROM send
      WHERE lower(to_email) = ? AND outcome IN ('pending', 'sent', 'silent')
      ORDER BY sent_at DESC LIMIT 1`,
  ).get(email.toLowerCase()) as { id: string } | undefined;
  if (row) return row.id;

  const any = prep(
    getDb(),
    'SELECT id FROM send WHERE lower(to_email) = ? ORDER BY sent_at DESC LIMIT 1',
  ).get(email.toLowerCase()) as { id: string } | undefined;
  return any?.id ?? null;
}

function sendExists(sendId: string): boolean {
  return prep(getDb(), 'SELECT 1 FROM send WHERE id = ?').get(sendId) !== undefined;
}

function matchReply(
  msg: gmail_v1.Schema$Message,
  headers: { name?: string | null; value?: string | null }[],
  fromEmail: string | null,
): string | null {
  const byThread = sendIdFromThread(msg.threadId ?? null);
  if (byThread) return byThread;

  const candidates = [
    extractMessageId(headerValue(headers, 'In-Reply-To')),
    ...extractMessageIds(headerValue(headers, 'References')).reverse(),
  ].filter((v): v is string => Boolean(v));

  for (const messageId of candidates) {
    const row = prep(
      getDb(),
      'SELECT id FROM send WHERE message_id = ? ORDER BY sent_at DESC LIMIT 1',
    ).get(messageId) as { id: string } | undefined;
    if (row) return row.id;
  }

  return sendIdFromRecipient(fromEmail);
}

function isAutoReply(
  headers: { name?: string | null; value?: string | null }[],
  msg: gmail_v1.Schema$Message,
): boolean {
  const autoSubmitted = headerValue(headers, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return true;

  if (hasHeader(headers, 'X-Autoreply') || hasHeader(headers, 'X-Autorespond')) return true;

  const precedence = headerValue(headers, 'Precedence')?.trim().toLowerCase();
  if (precedence === 'auto_reply') return true;

  const subject = headerValue(headers, 'Subject') ?? '';
  if (AUTOREPLY_SUBJECT.test(subject)) return true;

  return (msg.labelIds ?? []).includes('CATEGORY_UPDATES') && AUTOREPLY_SUBJECT.test(subject);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

function persist(msg: gmail_v1.Schema$Message): boolean {
  if (!msg.id) return false;

  const headers = msg.payload?.headers ?? [];
  const classification = classify(msg);
  const rawId = storeRaw(msg);

  const parsedDate = msg.internalDate ? Number(msg.internalDate) : NaN;
  const receivedAt = Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : Date.now();
  const fromEmail = extractAddress(headerValue(headers, 'From'));
  const subject = headerValue(headers, 'Subject');

  const res = prep(
    getDb(),
    `INSERT INTO inbound
       (id, gmail_id, thread_id, send_id, from_email, subject, snippet, kind,
        bounce_recipient, bounce_status, handled, received_at, raw_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(gmail_id) DO NOTHING`,
  ).run(
    ulid(receivedAt),
    msg.id,
    msg.threadId ?? null,
    classification.sendId,
    fromEmail,
    subject,
    msg.snippet ?? null,
    classification.kind,
    classification.bounceRecipient,
    classification.bounceStatus,
    receivedAt,
    rawId,
  );

  const isNew = Number(res.changes) > 0;
  if (isNew) applyOutcome(classification);
  return isNew;
}

/**
 * A 4.x.x "delayed" DSN and an out-of-office both look like traffic but neither
 * settles the send, so only a permanent failure or a genuine human reply moves
 * the outcome off 'sent'.
 */
function applyOutcome(c: Classification): void {
  if (!c.sendId) return;

  if (c.kind === 'bounce' && c.permanentFailure) {
    prep(
      getDb(),
      `UPDATE send SET outcome = 'bounced', outcome_at = ?
        WHERE id = ? AND outcome IN ('pending', 'sent', 'silent')`,
    ).run(Date.now(), c.sendId);
    return;
  }

  if (c.kind === 'reply') {
    prep(
      getDb(),
      `UPDATE send SET outcome = 'replied', outcome_at = ?
        WHERE id = ? AND outcome IN ('pending', 'sent', 'silent')`,
    ).run(Date.now(), c.sendId);
  }
}

/**
 * Silence is the expected majority outcome, not an error state. Naming it after
 * a fixed window stops the dashboard from showing hundreds of sends stuck in
 * 'sent' forever and pretending an answer is still coming.
 */
function markSilentSends(): void {
  prep(
    getDb(),
    `UPDATE send SET outcome = 'silent', outcome_at = ?
      WHERE outcome = 'sent' AND sent_at IS NOT NULL AND sent_at < ?`,
  ).run(Date.now(), Date.now() - SILENT_AFTER_DAYS * DAY_MS);
}

function storeRaw(msg: gmail_v1.Schema$Message): number | null {
  try {
    const json = JSON.stringify(msg);
    const sha256 = createHash('sha256').update(json).digest('hex');
    const body = gzipSync(Buffer.from(json, 'utf8'));

    const row = prep(
      getDb(),
      `INSERT INTO raw_response
         (sha256, source, url, status_code, encoding, body, bytes_raw, bytes_stored, fetched_at)
       VALUES (?, 'gmail', ?, 200, 'gzip', ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET fetched_at = excluded.fetched_at
       RETURNING id`,
    ).get(
      sha256,
      `gmail://messages/${msg.id ?? ''}`,
      body,
      Buffer.byteLength(json, 'utf8'),
      body.length,
      Date.now(),
    ) as { id: number } | undefined;

    return row?.id ?? null;
  } catch (err) {
    // Evidence is valuable but not worth losing the inbound row over.
    console.warn('[gmail] could not store raw message:', err);
    return null;
  }
}
