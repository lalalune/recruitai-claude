/**
 * Outbound send.
 *
 * Everything here is built around one requirement: after the API call returns,
 * we must be able to attribute a bounce or a reply back to the exact send row.
 * That is why three identifiers are persisted immediately and synchronously —
 * the custom header (ours), the Gmail thread id (Gmail's, and the one that
 * actually matches replies), and the RFC 5322 Message-ID that Gmail rewrites on
 * the way out and which is therefore only knowable by reading it back.
 */

import { getDb, prep } from '../db/index.js';
import { COMPANY_SUPPRESSION_MATCH } from '../pipeline/suppression.js';
import {
  getGmailClient,
  gmailCall,
  getAddress,
  isConnected,
  needsReauth,
  setSetting,
  KEY_ADDRESS,
  GmailAuthError,
} from './oauth.js';
import { buildRawMessage, SEND_ID_HEADER, headerValue, extractMessageId } from './mime.js';

export interface SendRequest {
  to: string;
  subject: string;
  body: string;
  /** ULID of the `send` row. Becomes the X-RecruitAI-Send-Id header value. */
  sendId: string;
  /** Company the recipient belongs to — lets the last-gate suppression check honour kind='company' rules. */
  companyId?: string;
  /** Set to continue an existing Gmail thread (follow-ups). */
  threadId?: string;
  /** RFC 5322 Message-ID being replied to, angle brackets included. */
  inReplyTo?: string;
  references?: string[];
}

export interface SendResult {
  gmailId: string;
  threadId: string;
  messageId: string | null;
  toEmail: string;
  fromEmail: string;
  sentAt: number;
}

/** The address is suppressed; the send did not happen and must not be retried. */
export class SuppressedRecipientError extends Error {
  readonly suppressed = true;
  constructor(
    readonly email: string,
    readonly reason: string,
  ) {
    super(`${email} is suppressed (${reason}) — refusing to send.`);
    this.name = 'SuppressedRecipientError';
  }
}

// Deliberately conservative. A value that fails this never came from a real
// source document, and hard rule #1 says contact values are observed, not made.
const ADDRESS_RE = /^[^\s@<>",;]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function isPlausibleAddress(email: string): boolean {
  return email.length <= 254 && ADDRESS_RE.test(email);
}

/**
 * Last gate before the wire. The queue checks suppression too, but this is the
 * only check that is physically between the operator's intent and Google's
 * servers, so it is repeated here rather than assumed — including the
 * company-kind rules, which this gate historically skipped.
 */
export function assertNotSuppressed(email: string, companyId?: string): void {
  const normalised = email.trim().toLowerCase();
  const domain = normalised.slice(normalised.lastIndexOf('@') + 1);

  const hit = prep(
    getDb(),
    `SELECT s.reason FROM suppression s
      WHERE (s.kind = 'email'  AND lower(s.value) = ?)
         OR (s.kind = 'domain' AND lower(s.value) = ?)
         OR (s.kind = 'company' AND ? IS NOT NULL AND EXISTS (
               SELECT 1 FROM company co WHERE co.id = ? AND ${COMPANY_SUPPRESSION_MATCH}))
      LIMIT 1`,
  ).get(normalised, domain, companyId ?? null, companyId ?? null) as { reason: string } | undefined;

  if (hit) throw new SuppressedRecipientError(normalised, hit.reason);
}

async function resolveFromAddress(): Promise<string> {
  const stored = getAddress();
  if (stored) return stored;

  const api = await getGmailClient();
  const profile = await gmailCall(() => api.users.getProfile({ userId: 'me' }));
  const address = profile.data.emailAddress;
  if (!address) throw new GmailAuthError('Could not determine the connected Gmail address.');
  setSetting(KEY_ADDRESS, address);
  return address;
}

export async function sendMessage(req: SendRequest): Promise<SendResult> {
  if (!(await isConnected())) throw new GmailAuthError('Gmail is not connected.');
  if (needsReauth()) {
    throw new GmailAuthError('Gmail authorisation has expired. Reconnect in Settings.');
  }

  const to = req.to.trim();
  if (!isPlausibleAddress(to)) {
    throw new Error(`Refusing to send: "${req.to}" is not a valid email address.`);
  }
  if (!req.sendId) throw new Error('sendMessage requires a sendId.');
  if (!req.subject.trim()) throw new Error('Refusing to send a message with an empty subject.');
  if (!req.body.trim()) throw new Error('Refusing to send a message with an empty body.');

  assertNotSuppressed(to, req.companyId);

  const from = await resolveFromAddress();
  const raw = await buildRawMessage({
    from,
    to,
    subject: req.subject,
    body: req.body,
    sendId: req.sendId,
    inReplyTo: req.inReplyTo,
    references: req.references,
  });

  const api = await getGmailClient();

  let gmailId: string;
  let threadId: string;
  try {
    const res = await gmailCall(() =>
      api.users.messages.send({
        userId: 'me',
        requestBody: req.threadId ? { raw, threadId: req.threadId } : { raw },
      }),
    );
    if (!res.data.id) throw new Error('Gmail accepted the message but returned no id.');
    gmailId = res.data.id;
    threadId = res.data.threadId ?? '';
  } catch (err) {
    recordSendFailure(req.sendId, err);
    throw err;
  }

  const sentAt = Date.now();

  // Persist before the read-back: if the Message-ID fetch fails we still know a
  // message left the building, which matters far more than the header does.
  prep(
    getDb(),
    `UPDATE send
        SET gmail_id = ?, gmail_thread_id = ?, sent_at = ?, outcome = 'sent', error = NULL
      WHERE id = ?`,
  ).run(gmailId, threadId || null, sentAt, req.sendId);

  const messageId = await readBackMessageId(gmailId);
  if (messageId) {
    prep(getDb(), 'UPDATE send SET message_id = ? WHERE id = ?').run(messageId, req.sendId);
  }

  return { gmailId, threadId, messageId, toEmail: to, fromEmail: from, sentAt };
}

/**
 * Gmail replaces whatever Message-ID the composer generated, so the only way to
 * learn the real one is to ask for it afterwards. Non-fatal: thread id already
 * covers reply matching, this is the belt to its braces.
 */
async function readBackMessageId(gmailId: string): Promise<string | null> {
  try {
    const api = await getGmailClient();
    const res = await gmailCall(() =>
      api.users.messages.get({
        userId: 'me',
        id: gmailId,
        format: 'metadata',
        metadataHeaders: ['Message-ID'],
      }),
    );
    return extractMessageId(headerValue(res.data.payload?.headers, 'Message-ID'));
  } catch (err) {
    console.warn(`[gmail] could not read back Message-ID for ${gmailId}:`, err);
    return null;
  }
}

function recordSendFailure(sendId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    prep(
      getDb(),
      `UPDATE send SET outcome = 'failed', outcome_at = ?, error = ? WHERE id = ?`,
    ).run(Date.now(), message.slice(0, 2000), sendId);
  } catch (dbErr) {
    console.warn('[gmail] could not record send failure:', dbErr);
  }
}

/**
 * Sends the operator a copy of a message to their own inbox. Used by the
 * Settings "test send" button; bypasses the send table because there is no
 * campaign row behind it.
 */
export async function sendTestMessage(): Promise<{ ok: boolean; message: string }> {
  try {
    const from = await resolveFromAddress();
    const api = await getGmailClient();
    const raw = await buildRawMessage({
      from,
      to: from,
      subject: 'recruitAI test send',
      body:
        'This is a test message from recruitAI.\n\n' +
        'If you can read this, sending works and the outbound header is being stamped.\n',
      sendId: `test-${Date.now()}`,
    });

    const res = await gmailCall(() =>
      api.users.messages.send({ userId: 'me', requestBody: { raw } }),
    );

    return res.data.id
      ? { ok: true, message: `Test message sent to ${from}. Check your inbox.` }
      : { ok: false, message: 'Gmail accepted the request but returned no message id.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Exposed so the queue can log which header value it is looking for on bounce. */
export const OUTBOUND_SEND_ID_HEADER = SEND_ID_HEADER;
