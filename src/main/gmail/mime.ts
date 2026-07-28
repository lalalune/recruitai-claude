/**
 * MIME construction and parsing.
 *
 * Outbound uses nodemailer's MailComposer rather than hand-rolled string
 * concatenation because header folding, encoding of non-ASCII subjects and
 * address escaping are all places where "it worked in testing" quietly produces
 * a malformed message for one recipient in a hundred.
 *
 * Inbound parsing is deliberately minimal: Gmail already gives us a decoded part
 * tree, so all we need is base64url decoding, header lookup and the RFC 3464
 * delivery-status grammar.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { gmail_v1 } from '@googleapis/gmail';

/** The header every outbound message carries. Primary bounce-attribution key. */
export const SEND_ID_HEADER = 'X-RecruitAI-Send-Id';

export interface OutboundMessage {
  from: string;
  to: string;
  subject: string;
  /** Plain text. See buildRawMessage for why there is no HTML alternative. */
  body: string;
  sendId: string;
  /** RFC 5322 Message-ID of the message being replied to, angle brackets included. */
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
}

/**
 * Returns a base64url-encoded RFC 5322 message, which is exactly what
 * users.messages.send wants in `raw`.
 *
 * Text-only, no multipart/alternative: this is one-to-one outreach from a
 * personal mailbox, and a text/plain message both looks hand-written and skips
 * the HTML-heuristic penalties that bulk mail attracts.
 */
export async function buildRawMessage(msg: OutboundMessage): Promise<string> {
  const headers: Record<string, string> = { [SEND_ID_HEADER]: msg.sendId };

  const composer = new MailComposer({
    from: msg.from,
    to: msg.to,
    replyTo: msg.replyTo,
    subject: msg.subject,
    text: msg.body,
    headers,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    textEncoding: 'quoted-printable',
    // nodemailer's own casing rule would emit "X-Recruitai-Send-ID". Header
    // names are case-insensitive so nothing breaks, but the operator reading raw
    // message source should see the name this codebase documents.
    // The key arrives already normalised, so returning it unchanged preserves
    // nodemailer's behaviour for every other header.
    normalizeHeaderKey: (key: string) =>
      key.toLowerCase() === SEND_ID_HEADER.toLowerCase() ? SEND_ID_HEADER : key,
  });

  const built = await new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  return built.toString('base64url');
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound helpers
// ─────────────────────────────────────────────────────────────────────────────

export type Header = { name?: string | null; value?: string | null };

export function headerValue(headers: Header[] | null | undefined, name: string): string | null {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? '').toLowerCase() === want) return h.value ?? null;
  }
  return null;
}

export function hasHeader(headers: Header[] | null | undefined, name: string): boolean {
  return headerValue(headers, name) !== null;
}

/** Depth-first flatten of the Gmail part tree, root included. */
export function flattenParts(payload: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart[] {
  if (!payload) return [];
  const out: gmail_v1.Schema$MessagePart[] = [];
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop()!;
    out.push(part);
    for (const child of part.parts ?? []) stack.push(child);
  }
  return out;
}

export function decodePartBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  const data = part?.body?.data;
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export function findPart(
  parts: gmail_v1.Schema$MessagePart[],
  mimeType: string,
): gmail_v1.Schema$MessagePart | undefined {
  const want = mimeType.toLowerCase();
  return parts.find((p) => (p.mimeType ?? '').toLowerCase() === want);
}

/** `multipart/report; report-type=delivery-status` → { type, params: {report-type: ...} } */
export function parseContentType(value: string | null): {
  type: string;
  params: Record<string, string>;
} {
  if (!value) return { type: '', params: {} };
  const segments = value.split(';');
  const type = (segments.shift() ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

/** `"Mail Delivery Subsystem" <mailer-daemon@googlemail.com>` → the address. */
export function extractAddress(value: string | null): string | null {
  if (!value) return null;
  const angle = value.match(/<([^>]+)>/);
  const raw = (angle?.[1] ?? value).trim();
  const bare = raw.match(/[^\s<>,;"]+@[^\s<>,;"]+/);
  return bare ? bare[0].toLowerCase() : null;
}

/** First `<...>` token — Message-ID / In-Reply-To values, which may be folded. */
export function extractMessageId(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/<[^<>\s]+>/);
  return m ? m[0] : null;
}

/** All `<...>` tokens, oldest-first as they appear in a References header. */
export function extractMessageIds(value: string | null): string[] {
  if (!value) return [];
  return value.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * Unfolds RFC 5322 continuation lines (a line beginning with WSP belongs to the
 * previous field) and returns ordered name/value pairs. Used for both
 * message/delivery-status bodies and returned original headers.
 */
export function parseHeaderBlock(text: string): Header[] {
  const out: Header[] = [];
  const lines = text.split(/\r?\n/);
  let current: { name: string; value: string } | null = null;

  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (current) current.value += ' ' + line.trim();
      continue;
    }
    if (current) {
      out.push(current);
      current = null;
    }
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    current = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
  }
  if (current) out.push(current);
  return out;
}

export interface DeliveryStatusRecipient {
  finalRecipient: string | null;
  originalRecipient: string | null;
  action: string | null;
  status: string | null;
  diagnosticCode: string | null;
  remoteMta: string | null;
}

/**
 * Parses a message/delivery-status body. Per RFC 3464 it is a per-message header
 * block followed by one blank-line-separated block per recipient, so blocks
 * after the first are the ones that carry Final-Recipient.
 */
export function parseDeliveryStatus(body: string): DeliveryStatusRecipient[] {
  const blocks = body.split(/\r?\n[ \t]*\r?\n/);
  const out: DeliveryStatusRecipient[] = [];

  for (const block of blocks) {
    const headers = parseHeaderBlock(block);
    const final = headerValue(headers, 'Final-Recipient');
    const original = headerValue(headers, 'Original-Recipient');
    if (!final && !original) continue;

    out.push({
      // Values are `type; value`, e.g. `rfc822; nobody@example.com`.
      finalRecipient: extractAddress(stripAddressType(final)),
      originalRecipient: extractAddress(stripAddressType(original)),
      action: headerValue(headers, 'Action')?.toLowerCase() ?? null,
      status: headerValue(headers, 'Status'),
      diagnosticCode: headerValue(headers, 'Diagnostic-Code'),
      remoteMta: headerValue(headers, 'Remote-MTA'),
    });
  }

  return out;
}

function stripAddressType(value: string | null): string | null {
  if (!value) return null;
  const semi = value.indexOf(';');
  return semi === -1 ? value : value.slice(semi + 1).trim();
}
