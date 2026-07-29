/**
 * MIME construction byte-shape, RFC 5322 unfolding, and the RFC 3464
 * delivery-status grammar — including the shape RFC 3464 explicitly allows and
 * that breaks naive parsers: a DSN whose optional third part (the returned
 * original headers, and with them our X-RecruitAI-Send-Id) is simply absent.
 *
 * Attribution is best-effort by design. What is NOT allowed to be best-effort:
 * crashing, mis-reading a 4.x.x delay warning as a dead address, or letting a
 * folded Diagnostic-Code truncate into a wrong status code. Each of those turns
 * a deliverable address into a permanently suppressed one.
 *
 * The bounce fixtures below are written by hand to match what Google, Exchange
 * and Postfix actually emit, then replayed through the real syncInbox against a
 * faked API surface. No network.
 */

// Must come first: patches require('electron') before any app module loads.
import { installElectronStub } from '../e2e/electron-stub.js';

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { gmail_v1 } from '@googleapis/gmail';
import { initDb, closeDb, getDb, get, run, ulid } from '../../src/main/db/index.js';
import {
  SEND_ID_HEADER,
  buildRawMessage,
  extractAddress,
  extractMessageId,
  extractMessageIds,
  headerValue,
  parseDeliveryStatus,
  parseHeaderBlock,
} from '../../src/main/gmail/mime.js';
import { syncInbox } from '../../src/main/gmail/inbox.js';
import { KEY_HISTORY_ID, KEY_REFRESH_TOKEN, setSecret } from '../../src/main/gmail/oauth.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';

installElectronStub();

let tmpRoot = '';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-gmail-mime-'));
  initDb(path.join(tmpRoot, 'gmail-mime.db'));
  await setSecret(KEY_REFRESH_TOKEN, 'test-refresh-token');
});

after(() => {
  closeDb();
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows holds handles past close() long enough to defeat retries — a
       leaked CI tmpdir must not fail the suite (same stance as the stub). */
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Outbound byte shape
// ─────────────────────────────────────────────────────────────────────────────

async function compose(over: Partial<Parameters<typeof buildRawMessage>[0]> = {}): Promise<string> {
  const raw = await buildRawMessage({
    from: 'shaw@example.com',
    to: 'ada@northwind.example',
    subject: 'Your Staff Engineer req',
    body: 'Hi Ada,\n\nShort note.\n\n— Shaw',
    sendId: '01JMIMESENDID000000000000',
    ...over,
  });
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('gmail-mime outbound byte shape', () => {
  test('gmail-mime the send-id header keeps its exact documented casing', async () => {
    const decoded = await compose();

    // nodemailer's own normaliser title-cases each dash-separated token and
    // upper-cases a trailing "id", producing X-Recruitai-Send-ID. The operator
    // reading raw source must see the name this codebase documents, so the
    // assertion is on bytes, not on a case-insensitive lookup.
    const line = `${SEND_ID_HEADER}: 01JMIMESENDID000000000000\r\n`;
    assert.ok(
      decoded.startsWith(line) || decoded.includes(`\r\n${line}`),
      `header line not found with exact casing:\n${decoded.slice(0, 600)}`,
    );
    assert.ok(!decoded.includes('X-Recruitai-Send-ID'), 'nodemailer default casing leaked through');
    assert.ok(!decoded.includes('x-recruitai-send-id'), 'the header was lower-cased');
    assert.equal(decoded.match(/X-RecruitAI-Send-Id/g)?.length, 1, 'header must appear exactly once');
  });

  test('gmail-mime a mixed-EOL body is normalised to uniform CRLF on the wire', async () => {
    // A body pasted from a Mac-classic source, a Windows editor, and the
    // renderer's own textarea all in one. RFC 5322 allows CR and LF only as
    // the CRLF pair; a bare one is what makes a message "look forged" to some
    // filters and truncates it outright in others.
    const decoded = await compose({ body: 'Hi Ada,\r\rWindows line\r\nUnix line\nEnd' });

    assert.ok(!/\r(?!\n)/.test(decoded), 'a bare CR survived into the wire form');
    assert.ok(!/(?<!\r)\n/.test(decoded), 'a bare LF survived into the wire form');
  });

  test('gmail-mime an ASCII subject is left alone; the encoding is not applied blindly', async () => {
    const decoded = await compose({ subject: 'Your Staff Engineer req' });
    assert.ok(decoded.includes('\r\nSubject: Your Staff Engineer req\r\n'));
    assert.ok(!/Subject: =\?/.test(decoded), 'an ASCII subject was needlessly RFC 2047 encoded');
  });

  test('gmail-mime replyTo and threading headers appear only when supplied', async () => {
    const bare = await compose();
    assert.ok(!/\r\nReply-To:/i.test(bare));
    assert.ok(!/\r\nIn-Reply-To:/i.test(bare));
    assert.ok(!/\r\nReferences:/i.test(bare));

    const threaded = await compose({
      replyTo: 'shaw+replies@example.com',
      inReplyTo: '<orig@mail.example>',
      references: ['<older@mail.example>', '<orig@mail.example>'],
    });
    const headers = parseHeaderBlock(threaded.slice(0, threaded.indexOf('\r\n\r\n')));
    assert.equal(headerValue(headers, 'Reply-To'), 'shaw+replies@example.com');
    assert.equal(headerValue(headers, 'In-Reply-To'), '<orig@mail.example>');
    assert.deepEqual(extractMessageIds(headerValue(headers, 'References')), [
      '<older@mail.example>',
      '<orig@mail.example>',
    ]);
  });

  test('gmail-mime the raw payload is unpadded base64url, which is all messages.send accepts', async () => {
    const raw = await buildRawMessage({
      from: 'shaw@example.com',
      to: 'ada@northwind.example',
      subject: 'Padding probe ✓',
      body: 'Hi Ada,\n\nA body long enough that the base64 length lands off a 3-byte boundary.',
      sendId: '01JPADDINGPROBE0000000000',
    });
    assert.match(raw, /^[A-Za-z0-9_-]+$/, 'raw is not clean base64url');
    assert.ok(!raw.includes('='), 'base64 padding leaked in');
    assert.ok(!raw.includes('+') && !raw.includes('/'), 'standard-base64 alphabet leaked in');
  });

  test('gmail-mime a long unbreakable body line is folded rather than emitted over the 998 limit', async () => {
    const decoded = await compose({ body: `Hi Ada,\n\n${'x'.repeat(2000)}\n\n— Shaw` });
    for (const line of decoded.split('\r\n')) {
      assert.ok(line.length <= 998, `line exceeds the RFC 5322 998-octet limit: ${line.length}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header unfolding
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail-mime parseHeaderBlock', () => {
  test('gmail-mime unfolds space and tab continuations into one logical field', () => {
    const block = [
      'Subject: a subject that a sending MTA',
      ' decided to fold across',
      '\tthree separate lines',
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    ].join('\r\n');

    const headers = parseHeaderBlock(block);
    assert.equal(headers.length, 2);
    assert.equal(
      headerValue(headers, 'Subject'),
      'a subject that a sending MTA decided to fold across three separate lines',
    );
    assert.equal(extractAddress(headerValue(headers, 'From')), 'mailer-daemon@googlemail.com');
  });

  test('gmail-mime a folded References header still yields every message id in order', () => {
    const headers = parseHeaderBlock(
      'References: <a@mail.example>\r\n\t<b@mail.example>\r\n <c@mail.example>',
    );
    assert.deepEqual(extractMessageIds(headerValue(headers, 'References')), [
      '<a@mail.example>',
      '<b@mail.example>',
      '<c@mail.example>',
    ]);
    assert.equal(extractMessageId(headerValue(headers, 'References')), '<a@mail.example>');
  });

  test('gmail-mime a value containing a colon is not split at the wrong colon', () => {
    const headers = parseHeaderBlock('Diagnostic-Code: smtp; 550 5.1.1 User unknown: no such mailbox');
    assert.equal(headerValue(headers, 'Diagnostic-Code'), 'smtp; 550 5.1.1 User unknown: no such mailbox');
  });

  test('gmail-mime junk lines, LF-only blocks, and empty input degrade quietly', () => {
    assert.deepEqual(parseHeaderBlock(''), []);
    assert.deepEqual(parseHeaderBlock('\r\n\r\n'), []);
    // A garbage line with no colon is dropped, and it must not swallow the
    // header that follows it.
    const headers = parseHeaderBlock('this line has no colon\nStatus: 5.1.1');
    assert.equal(headers.length, 1);
    assert.equal(headerValue(headers, 'Status'), '5.1.1');
    // Lookup is case-insensitive in both directions.
    assert.equal(headerValue(headers, 'STATUS'), '5.1.1');
    assert.equal(headerValue(null, 'Status'), null);
    assert.equal(headerValue([{ name: null, value: null }], 'Status'), null);
  });
});

describe('gmail-mime address and message-id extraction', () => {
  test('gmail-mime pulls the address out of every shape a From line takes', () => {
    assert.equal(extractAddress('"Mail Delivery Subsystem" <MAILER-DAEMON@googlemail.com>'), 'mailer-daemon@googlemail.com');
    assert.equal(extractAddress('ada@northwind.example'), 'ada@northwind.example');
    assert.equal(extractAddress('Ada <ada@northwind.example>, Bob <bob@x.example>'), 'ada@northwind.example');
    assert.equal(extractAddress('postmaster'), null);
    assert.equal(extractAddress(null), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RFC 3464 delivery-status grammar
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail-mime parseDeliveryStatus', () => {
  test('gmail-mime reads a Google-shaped hard bounce', () => {
    const body = [
      'Reporting-MTA: dns; googlemail.com',
      'Received-From-MTA: dns; mail-sor.example.com',
      'Arrival-Date: Tue, 28 Jul 2026 09:14:02 -0700 (PDT)',
      '',
      'Final-Recipient: rfc822; nobody@northwind.example',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.',
      'Last-Attempt-Date: Tue, 28 Jul 2026 09:14:05 -0700 (PDT)',
    ].join('\r\n');

    const [r, ...rest] = parseDeliveryStatus(body);
    assert.equal(rest.length, 0, 'the per-message block must not be mistaken for a recipient');
    assert.equal(r!.finalRecipient, 'nobody@northwind.example', 'the "rfc822;" address type was not stripped');
    assert.equal(r!.action, 'failed');
    assert.equal(r!.status, '5.1.1');
    assert.match(r!.diagnosticCode!, /does not exist/);
  });

  test('gmail-mime keeps every recipient block, in order, when a DSN covers several', () => {
    const body = [
      'Reporting-MTA: dns; mx.example.net',
      '',
      'Final-Recipient: rfc822; delivered@northwind.example',
      'Action: delivered',
      'Status: 2.0.0',
      '',
      'Original-Recipient: rfc822; alias@northwind.example',
      'Final-Recipient: rfc822; dead@northwind.example',
      'Action: failed',
      'Status: 5.1.1',
    ].join('\r\n');

    const rows = parseDeliveryStatus(body);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.action, 'delivered');
    assert.equal(rows[1]!.action, 'failed');
    assert.equal(rows[1]!.originalRecipient, 'alias@northwind.example');
    assert.equal(rows[1]!.finalRecipient, 'dead@northwind.example');
  });

  test('gmail-mime a folded Diagnostic-Code is unfolded before the status is read from it', () => {
    // Exchange folds long diagnostics routinely. A parser that keeps only the
    // first physical line reads "smtp; 550 5.4.1" as the whole code and can
    // lose the enhanced status entirely.
    const body = [
      'Reporting-MTA: dns; exchange.example.com',
      '',
      'Final-Recipient: rfc822; gone@northwind.example',
      'Action: failed',
      'Diagnostic-Code: smtp; 550 5.4.1 Recipient address rejected:',
      ' Access denied. AS(201806281) [BL0PR01MB.namprd01.prod.outlook.com',
      '\t2026-07-28T16:14:02.884Z]',
    ].join('\r\n');

    const [r] = parseDeliveryStatus(body);
    assert.match(r!.diagnosticCode!, /Access denied/, 'the continuation line was dropped');
    assert.match(r!.diagnosticCode!, /5\.4\.1/);
    assert.equal(r!.status, null, 'there is no Status field here; one must not be invented');
  });

  test('gmail-mime a block separator carrying trailing whitespace still separates', () => {
    const body = 'Reporting-MTA: dns; mx.example.net\r\n \r\nFinal-Recipient: rfc822; x@y.example\r\nAction: failed';
    const rows = parseDeliveryStatus(body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.finalRecipient, 'x@y.example');
  });

  test('gmail-mime an empty or recipient-less delivery-status body yields nothing, not a crash', () => {
    assert.deepEqual(parseDeliveryStatus(''), []);
    assert.deepEqual(parseDeliveryStatus('Reporting-MTA: dns; mx.example.net'), []);
    assert.deepEqual(parseDeliveryStatus('total garbage with no colon at all'), []);
  });

  test('gmail-mime an Original-Recipient-only block is still a recipient', () => {
    const rows = parseDeliveryStatus(
      'Reporting-MTA: dns; mx.example.net\r\n\r\nOriginal-Recipient: rfc822; only@northwind.example\r\nAction: failed\r\nStatus: 5.2.1',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.finalRecipient, null);
    assert.equal(rows[0]!.originalRecipient, 'only@northwind.example');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole bounces, replayed through the real sync
// ─────────────────────────────────────────────────────────────────────────────

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

interface DsnOptions {
  gmailId: string;
  threadId: string;
  status: string;
  action: string;
  recipient: string;
  /** Omit to produce the two-part DSN RFC 3464 explicitly permits. */
  returnedSendId?: string;
  boundary?: string;
}

/** A multipart/report DSN shaped the way a real MTA emits one. */
function dsn(opts: DsnOptions): gmail_v1.Schema$Message {
  const boundary = opts.boundary ?? '000000000000abcdef';
  const parts: gmail_v1.Schema$MessagePart[] = [
    {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
      body: {
        data: b64(
          `** Address not found **\r\n\r\nYour message wasn't delivered to ${opts.recipient}.\r\n`,
        ),
      },
    },
    {
      mimeType: 'message/delivery-status',
      headers: [{ name: 'Content-Type', value: 'message/delivery-status' }],
      body: {
        data: b64(
          [
            'Reporting-MTA: dns; googlemail.com',
            'Arrival-Date: Tue, 28 Jul 2026 09:14:02 -0700 (PDT)',
            '',
            `Final-Recipient: rfc822; ${opts.recipient}`,
            `Action: ${opts.action}`,
            `Status: ${opts.status}`,
            `Diagnostic-Code: smtp; ${opts.status.startsWith('5') ? '550' : '450'} ${opts.status} the server responded`,
            '',
          ].join('\r\n'),
        ),
      },
    },
  ];

  // RFC 3464 makes this third part OPTIONAL, and plenty of MTAs omit it. When
  // it is absent, X-RecruitAI-Send-Id attribution has to degrade to the thread
  // and then to the recipient address — never fail.
  if (opts.returnedSendId) {
    parts.push({
      mimeType: 'text/rfc822-headers',
      headers: [{ name: 'Content-Type', value: 'text/rfc822-headers; charset=UTF-8' }],
      body: {
        data: b64(
          [
            'From: Shaw <shaw@example.com>',
            `To: ${opts.recipient}`,
            'Subject: Your Staff Engineer req',
            `${SEND_ID_HEADER}: ${opts.returnedSendId}`,
            'Message-ID: <original@mail.example>',
            '',
          ].join('\r\n'),
        ),
      },
    });
  }

  return {
    id: opts.gmailId,
    threadId: opts.threadId,
    internalDate: String(Date.now()),
    labelIds: ['INBOX'],
    snippet: 'Address not found',
    payload: {
      mimeType: 'multipart/report',
      headers: [
        { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
        { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
        {
          name: 'Content-Type',
          value: `multipart/report; report-type=delivery-status; boundary="${boundary}"`,
        },
      ],
      parts,
    },
  };
}

/** Replays a fixed set of messages through the real syncInbox. */
function fakeGmailFor(messages: gmail_v1.Schema$Message[]) {
  const byId = new Map(messages.map((m) => [m.id!, m]));
  return {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'me@example.com', historyId: 'PROFILE' } }),
      history: { list: async () => ({ data: {} }) },
      messages: {
        list: async () => ({ data: { messages: messages.map((m) => ({ id: m.id })) } }),
        get: async ({ id }: { id: string }) => ({ data: byId.get(id)! }),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

let seq = 0;

/** A company/contact/draft/send chain, with the send already delivered. */
function seedSend(address: string, threadId: string): string {
  const db = getDb();
  const tag = `dsn${++seq}`;
  const companyId = upsertCompany(db, { name: `DSN Co ${seq}`, domain: `${tag}.dsn.test` });
  run(db, `UPDATE company SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now(), companyId);
  const contactId = ulid();
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
     VALUES (?, ?, 'Ada Lovelace', 'Ada', ?, 'contacted')`,
    contactId,
    companyId,
    address,
  );
  const draftId = ulid();
  run(
    db,
    `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 'Your req', 'Hi Ada,', 'sent')`,
    draftId,
    companyId,
    contactId,
  );
  const sendId = ulid();
  run(
    db,
    `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, gmail_id, gmail_thread_id,
                       message_id, sent_at, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, 'Your req', 'Hi Ada,', ?, ?, '<original@mail.example>', ?, 'sent', ?)`,
    sendId,
    draftId,
    companyId,
    contactId,
    address,
    `g-${sendId}`,
    threadId,
    Date.now(),
    Date.now(),
  );
  return sendId;
}

const outcomeOf = (sendId: string) =>
  get<{ outcome: string }>(getDb(), 'SELECT outcome FROM send WHERE id = ?', sendId)!.outcome;

const inboundFor = (gmailId: string) =>
  get<{ kind: string; send_id: string | null; bounce_recipient: string | null; bounce_status: string | null }>(
    getDb(),
    'SELECT kind, send_id, bounce_recipient, bounce_status FROM inbound WHERE gmail_id = ?',
    gmailId,
  );

beforeEach(() => {
  // Each case starts from a first-run mailbox so listByQuery is the path taken.
  run(getDb(), 'DELETE FROM setting WHERE key = ?', KEY_HISTORY_ID);
});

describe('gmail-mime DSN fixtures through syncInbox', () => {
  test('gmail-mime a 5.1.1 hard bounce with returned headers kills exactly the send it names', async () => {
    const address = 'nobody@hardbounce.dsn.test';
    const sendId = seedSend(address, 'thread-hard');
    // A second, unrelated send to the same address that the DSN does NOT name.
    const bystander = seedSend('someone@bystander.dsn.test', 'thread-bystander');

    const msg = dsn({
      gmailId: 'dsn-hard',
      threadId: 'thread-unrelated',
      status: '5.1.1',
      action: 'failed',
      recipient: address,
      returnedSendId: sendId,
    });
    await syncInbox(async () => fakeGmailFor([msg]));

    const row = inboundFor('dsn-hard')!;
    assert.equal(row.kind, 'bounce');
    assert.equal(row.send_id, sendId, 'the returned X-RecruitAI-Send-Id header is rank 1 and must win');
    assert.equal(row.bounce_recipient, address);
    assert.equal(row.bounce_status, '5.1.1');
    assert.equal(outcomeOf(sendId), 'bounced');
    assert.equal(outcomeOf(bystander), 'sent', 'an unrelated send was collaterally bounced');
  });

  test('gmail-mime a 4.x.x delay warning is recorded but must not kill the address', async () => {
    const address = 'slow@softbounce.dsn.test';
    const sendId = seedSend(address, 'thread-soft');

    const msg = dsn({
      gmailId: 'dsn-soft',
      threadId: 'thread-soft',
      status: '4.4.7',
      action: 'delayed',
      recipient: address,
      returnedSendId: sendId,
    });
    await syncInbox(async () => fakeGmailFor([msg]));

    const row = inboundFor('dsn-soft')!;
    assert.equal(row.kind, 'bounce');
    assert.equal(row.bounce_status, '4.4.7');
    assert.equal(
      outcomeOf(sendId),
      'sent',
      'a transient 4.x.x delay was treated as a permanent failure — this suppresses a live address',
    );
  });

  test('gmail-mime a DSN with no returned-headers part degrades to thread attribution', async () => {
    const address = 'gone@nothirdpart.dsn.test';
    const sendId = seedSend(address, 'thread-nothird');

    const msg = dsn({
      gmailId: 'dsn-nothird',
      threadId: 'thread-nothird',
      status: '5.1.1',
      action: 'failed',
      recipient: address,
    });
    await syncInbox(async () => fakeGmailFor([msg]));

    const row = inboundFor('dsn-nothird')!;
    assert.equal(row.kind, 'bounce');
    assert.equal(row.send_id, sendId, 'rank 2 (gmail thread id) did not carry the attribution');
    assert.equal(row.bounce_status, '5.1.1');
    assert.equal(outcomeOf(sendId), 'bounced');
  });

  test('gmail-mime with neither returned headers nor a matching thread, the recipient address attributes it', async () => {
    const address = 'gone@recipientonly.dsn.test';
    const sendId = seedSend(address, 'thread-known');

    const msg = dsn({
      gmailId: 'dsn-recipient',
      threadId: 'thread-that-matches-nothing',
      status: '5.1.1',
      action: 'failed',
      recipient: address,
    });
    await syncInbox(async () => fakeGmailFor([msg]));

    const row = inboundFor('dsn-recipient')!;
    assert.equal(row.send_id, sendId, 'rank 3 (Final-Recipient address) did not carry the attribution');
    assert.equal(outcomeOf(sendId), 'bounced');
  });

  test('gmail-mime an unattributable DSN is stored unmatched instead of crashing the sync', async () => {
    // No returned headers, an unknown thread, and an address we never wrote to.
    // Every attribution rank misses. The sync must still complete and the
    // evidence must still land.
    const msg = dsn({
      gmailId: 'dsn-orphan',
      threadId: 'thread-nowhere',
      status: '5.1.1',
      action: 'failed',
      recipient: 'stranger@somewhere-we-never-emailed.example',
    });
    const inserted = await syncInbox(async () => fakeGmailFor([msg]));

    assert.equal(inserted, 1);
    const row = inboundFor('dsn-orphan')!;
    assert.equal(row.kind, 'bounce');
    assert.equal(row.send_id, null);
    assert.equal(row.bounce_recipient, 'stranger@somewhere-we-never-emailed.example');
    assert.equal(row.bounce_status, '5.1.1');
  });

  test('gmail-mime a DSN missing its delivery-status part entirely is still classified as a bounce', async () => {
    // Some MTAs send a human-readable "undeliverable" with no machine part at
    // all. mailer-daemon in the From line is the only signal left.
    const msg: gmail_v1.Schema$Message = {
      id: 'dsn-noparts',
      threadId: 'thread-noparts',
      internalDate: String(Date.now()),
      labelIds: ['INBOX'],
      snippet: 'Undeliverable',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Mail Delivery Subsystem <MAILER-DAEMON@googlemail.com>' },
          { name: 'Subject', value: 'Undeliverable: Your Staff Engineer req' },
        ],
        body: { data: b64('Delivery has failed to these recipients.') },
      },
    };
    const inserted = await syncInbox(async () => fakeGmailFor([msg]));

    assert.equal(inserted, 1);
    const row = inboundFor('dsn-noparts')!;
    assert.equal(row.kind, 'bounce');
    assert.equal(row.bounce_recipient, null);
    assert.equal(row.bounce_status, null, 'a status must not be invented from nothing');
  });
});
