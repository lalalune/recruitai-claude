/**
 * The send path, end to end, against a fake Gmail gateway.
 *
 * This is the money path — claim, footer, threading, outcome bookkeeping,
 * pause classification — and it had zero direct coverage because it ends at
 * the network. The injectable gateway (production = the real gmail module)
 * lets every branch run for real: same SQL, same state machine, same errors.
 */

// Must come first: patches require('electron').
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, get, all, run, ulid, type Db } from '../../src/main/db/index.js';
import { setDataDir, patchSettings } from '../../src/main/settings.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';
import {
  sendOne,
  __setSendGatewayForTests,
  type SendGateway,
} from '../../src/main/ipc/outreach.js';
import { SuppressedRecipientError, type SendRequest } from '../../src/main/gmail/send.js';
import { GmailQuotaError } from '../../src/main/gmail/oauth.js';
import { DEFAULT_OPT_OUT_LINE } from '../../src/shared/outreach.js';

installElectronStub();

let tmpRoot = '';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-sendpath-'));
  setDataDir(tmpRoot);
  initDb(path.join(tmpRoot, 'sendpath.db'));
  await patchSettings({
    sending: { postalAddress: '548 Market St, San Francisco, CA', includeOptOutLine: true },
  });
});

after(() => {
  closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  __setSendGatewayForTests(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fakes and seeds
// ─────────────────────────────────────────────────────────────────────────────

function fakeGateway(
  behave?: (req: SendRequest) => Promise<void> | void,
): { gateway: SendGateway; requests: SendRequest[] } {
  const requests: SendRequest[] = [];
  const gateway: SendGateway = {
    isConnected: async () => true,
    getAddress: () => 'operator@example.test',
    sendMessage: async (req) => {
      requests.push(req);
      await behave?.(req);
      return {
        gmailId: `g-${req.sendId}`,
        threadId: req.threadId ?? `t-${req.sendId}`,
        messageId: `<${req.sendId}@mail.example>`,
        toEmail: req.to,
        fromEmail: 'operator@example.test',
        sentAt: Date.now(),
      };
    },
  };
  return { gateway, requests };
}

function seed(db: Db, tag: string, opts: { queuedBody?: string } = {}): { companyId: string; contactId: string; draftId: string } {
  const companyId = upsertCompany(db, { name: `Send ${tag}`, domain: `${tag}.sendpath.test` });
  run(db, `UPDATE company SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now(), companyId);
  const contactId = ulid();
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, first_name, email, status) VALUES (?, ?, 'Pat Doe', 'Pat', ?, 'approved')`,
    contactId,
    companyId,
    `pat@${tag}.sendpath.test`,
  );
  const draftId = ulid();
  run(
    db,
    `INSERT INTO draft (id, company_id, contact_id, subject, body, state, scheduled_at) VALUES (?, ?, ?, 'Your search', ?, 'queued', ?)`,
    draftId,
    companyId,
    contactId,
    opts.queuedBody ?? `Hi Pat,\n\nShort note.\n\n${DEFAULT_OPT_OUT_LINE}\n\n548 Market St, San Francisco, CA`,
    Date.now(),
  );
  return { companyId, contactId, draftId };
}

const sendRow = (db: Db, draftId: string) =>
  get<{ outcome: string; gmail_thread_id: string | null; message_id: string | null; body: string }>(
    db,
    'SELECT outcome, gmail_thread_id, message_id, body FROM send WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1',
    draftId,
  );

// ─────────────────────────────────────────────────────────────────────────────

describe('sendOne against the fake gateway', () => {
  test('the happy path: claim, send, bookkeeping', async () => {
    const db = getDb();
    const { contactId, draftId } = seed(db, 'happy');
    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, draftId);
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);

    const row = sendRow(db, draftId)!;
    assert.equal(row.outcome, 'sent');
    assert.ok(row.gmail_thread_id, 'thread id recorded for future follow-ups');
    assert.ok(row.message_id, 'Message-ID recorded for threading headers');
    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', draftId)!.state, 'sent');
    assert.equal(get<{ status: string }>(db, 'SELECT status FROM contact WHERE id = ?', contactId)!.status, 'contacted');
  });

  test('a stripped compliance footer is restored on the wire and in the ledger', async () => {
    const db = getDb();
    const { draftId } = seed(db, 'footer', { queuedBody: 'Hi Pat,\n\nEdited everything away.' });
    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, draftId);
    assert.equal(result.ok, true);
    assert.ok(requests[0]!.body.includes(DEFAULT_OPT_OUT_LINE), 'opt-out line reaches the wire');
    assert.ok(requests[0]!.body.includes('548 Market St'), 'postal address reaches the wire');
    assert.ok(sendRow(db, draftId)!.body.includes(DEFAULT_OPT_OUT_LINE), 'the ledger records what was actually sent');
  });

  test('a follow-up threads onto the original send', async () => {
    const db = getDb();
    const { companyId, contactId } = seed(db, 'thread');
    // Original, already sent, with the ids a bump threads onto.
    const origDraft = ulid();
    run(db, `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 's', 'b', 'sent')`, origDraft, companyId, contactId);
    const origSend = ulid();
    run(
      db,
      `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, sent_at, gmail_thread_id, message_id, created_at)
       VALUES (?, ?, ?, ?, 'pat@thread.sendpath.test', 's', 'b', 'silent', ?, 'THREAD-9', '<orig-9@mail.example>', ?)`,
      origSend,
      origDraft,
      companyId,
      contactId,
      Date.now() - 3 * 86_400_000,
      Date.now() - 3 * 86_400_000,
    );
    // Free the one-active-draft slot BEFORE inserting the bump (unique index).
    run(db, `UPDATE draft SET state = 'skipped' WHERE contact_id = ? AND state = 'queued'`, contactId);
    const bump = ulid();
    run(
      db,
      `INSERT INTO draft (id, company_id, contact_id, subject, body, state, follow_up_of, scheduled_at)
       VALUES (?, ?, ?, 'Re: s', 'bump', 'queued', ?, ?)`,
      bump,
      companyId,
      contactId,
      origSend,
      Date.now(),
    );

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, bump);
    assert.equal(result.ok, true, `expected ok, got: ${!result.ok ? result.reason : ''}`);
    assert.equal(requests[0]!.threadId, 'THREAD-9');
    assert.equal(requests[0]!.inReplyTo, '<orig-9@mail.example>');
    assert.deepEqual(requests[0]!.references, ['<orig-9@mail.example>']);
  });

  test('two concurrent sendOne calls produce exactly one send', async () => {
    const db = getDb();
    const { draftId } = seed(db, 'race');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { gateway, requests } = fakeGateway(() => gate);
    __setSendGatewayForTests(gateway);

    const [a, b] = [sendOne(db, draftId), sendOne(db, draftId)];
    // Let both pass their awaits; then release the transport.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(requests.length, 1, 'the claim admits exactly one transport call');
    assert.equal(all(db, 'SELECT id FROM send WHERE draft_id = ?', draftId).length, 1, 'and exactly one ledger row');
    assert.equal([ra, rb].filter((r) => r.ok).length, 1, 'one caller wins; the other reports idle');
  });

  test('a quota error requeues the draft and pauses the run', async () => {
    const db = getDb();
    const { draftId } = seed(db, 'quota');
    const { gateway } = fakeGateway(() => {
      throw new GmailQuotaError('Daily limit exceeded', 429, 'rateLimitExceeded');
    });
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, draftId);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.pause, true, 'quota is transport-wide: pause');
    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', draftId)!.state, 'queued', 'the draft is not burned');
    assert.equal(sendRow(db, draftId)!.outcome, 'failed', 'the attempt itself is on the ledger');
  });

  test('a network outage pauses instead of burning the queue', async () => {
    const db = getDb();
    const { draftId } = seed(db, 'offline');
    const { gateway } = fakeGateway(() => {
      throw new Error('request to https://gmail.googleapis.com failed, reason: getaddrinfo ENOTFOUND');
    });
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, draftId);
    assert.equal(!result.ok && result.pause, true, 'offline is transport-wide: pause');
    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', draftId)!.state, 'queued');
  });

  test('a last-gate suppression skips the draft permanently', async () => {
    const db = getDb();
    const { draftId } = seed(db, 'lastgate');
    const { gateway } = fakeGateway((req) => {
      throw new SuppressedRecipientError(req.to, 'opt_out');
    });
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, draftId);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.retryable, false, 'suppressed is never retryable');
    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', draftId)!.state, 'skipped');
  });

  // LAST on purpose: it floods the trailing-50 outcome window.
  test('the bounce circuit breaker trips before another message leaves', async () => {
    const db = getDb();
    const { companyId, contactId, draftId } = seed(db, 'breaker');
    for (let i = 0; i < 40; i++) {
      run(
        db,
        `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, created_at)
         VALUES (?, ?, ?, ?, 'x@breaker.sendpath.test', 's', 'b', ?, ?)`,
        ulid(),
        draftId,
        companyId,
        contactId,
        i < 6 ? 'bounced' : 'silent',
        Date.now() + i,
      );
    }
    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    const result = await sendOne(db, draftId);
    assert.equal(!result.ok && result.pause, true, 'the breaker pauses the run');
    assert.match(!result.ok ? result.reason : '', /Bounce circuit breaker/);
    assert.equal(requests.length, 0, 'no message leaves while tripped');
  });
});
