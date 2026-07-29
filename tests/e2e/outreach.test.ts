/**
 * The send governor.
 *
 * Everything here protects one thing: the operator's personal Gmail account.
 * Twenty an hour and a hundred and fifty a day is not a preference, it is the
 * rate at which a personal mailbox keeps its sending reputation. A cap that is
 * off by one is a rounding error; a cap that resets on restart, or that counts
 * only completed sends while a claim is in flight, is how a mailbox gets
 * flagged overnight.
 *
 * So each cap is asserted against the real `sendOne` with a fake gateway, and
 * every count is measured with the same exported accounting the sender uses —
 * a test that recomputed the counts itself would pass while the sender used a
 * different number.
 */

// Must come first: patches require('electron').
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, get, run, ulid, type Db } from '../../src/main/db/index.js';
import { setDataDir, patchSettings } from '../../src/main/settings.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';
import {
  __setSendGatewayForTests,
  getSendStats,
  isInSendWindow,
  pauseSending,
  queueDraft,
  queuedCount,
  reconcileInterruptedSends,
  sendOne,
  sentThisHour,
  sentToday,
  startSending,
  type SendGateway,
} from '../../src/main/ipc/outreach.js';
import type { SendRequest } from '../../src/main/gmail/send.js';

installElectronStub();

let tmpRoot = '';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-outreach-'));
  setDataDir(tmpRoot);
  initDb(path.join(tmpRoot, 'outreach.db'));
  await patchSettings({
    sending: { perHour: 20, perDay: 150, windowStart: '09:00', windowEnd: '17:00', weekends: false },
  });
});

after(() => {
  pauseSending(getDb());
  closeDb();
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows holds handles past close() long enough to defeat retries — a
       leaked CI tmpdir must not fail the suite (same stance as the stub). */
  }
});

afterEach(async () => {
  __setSendGatewayForTests(null);
  await patchSettings({ sending: { perHour: 20, perDay: 150 } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function fakeGateway(): { gateway: SendGateway; requests: SendRequest[] } {
  const requests: SendRequest[] = [];
  return {
    requests,
    gateway: {
      isConnected: async () => true,
      getAddress: () => 'operator@example.test',
      sendMessage: async (req) => {
        requests.push(req);
        return {
          gmailId: `g-${req.sendId}`,
          threadId: `t-${req.sendId}`,
          messageId: `<${req.sendId}@mail.example>`,
          toEmail: req.to,
          fromEmail: 'operator@example.test',
          sentAt: Date.now(),
        };
      },
    },
  };
}

let seq = 0;

interface Seeded {
  companyId: string;
  contactId: string;
  draftId: string;
  domain: string;
  email: string;
}

function seed(db: Db, tag: string, state: 'draft' | 'queued' = 'queued'): Seeded {
  const domain = `${tag}-${++seq}.outreach.test`;
  const companyId = upsertCompany(db, { name: `Outreach ${tag} ${seq}`, domain });
  run(db, `UPDATE company SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now(), companyId);
  const contactId = ulid();
  const email = `pat@${domain}`;
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
     VALUES (?, ?, 'Pat Doe', 'Pat', ?, 'approved')`,
    contactId,
    companyId,
    email,
  );
  const draftId = ulid();
  run(
    db,
    `INSERT INTO draft (id, company_id, contact_id, subject, body, state, scheduled_at)
     VALUES (?, ?, ?, 'Your search', 'Hi Pat,\n\nShort note.', ?, ?)`,
    draftId,
    companyId,
    contactId,
    state,
    state === 'queued' ? Date.now() : null,
  );
  return { companyId, contactId, draftId, domain, email };
}

/** A completed or in-flight send row, without going through the sender. */
function fakeSendRow(
  db: Db,
  owner: Seeded,
  opts: { sentAt?: number | null; createdAt?: number; outcome?: string },
): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, sent_at, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, 'filler', 'filler', ?, ?, ?)`,
    id,
    owner.draftId,
    owner.companyId,
    owner.contactId,
    owner.email,
    opts.sentAt ?? null,
    opts.outcome ?? 'sent',
    opts.createdAt ?? Date.now(),
  );
  return id;
}

function startOfLocalDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const draftState = (db: Db, id: string) =>
  get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', id)!.state;

// ─────────────────────────────────────────────────────────────────────────────
// Caps
// ─────────────────────────────────────────────────────────────────────────────

describe('outreach governor: rate caps', () => {
  test('outreach the hourly cap admits the last slot and then refuses', async () => {
    const db = getDb();
    const filler = seed(db, 'hourfill', 'draft');
    const first = seed(db, 'hourone');
    const second = seed(db, 'hourtwo');

    // One slot left in the trailing hour, measured with the sender's own
    // accounting rather than a count this test computed for itself.
    await patchSettings({ sending: { perHour: sentThisHour(db) + 1, perDay: 500 } });
    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    const ok = await sendOne(db, first.draftId);
    assert.equal(ok.ok, true, `expected the last slot to be usable: ${JSON.stringify(ok)}`);

    const blocked = await sendOne(db, second.draftId);
    assert.equal(blocked.ok, false);
    assert.match(!blocked.ok ? blocked.reason : '', /Hourly limit reached/);
    assert.equal(!blocked.ok && blocked.idle, true, 'a cap is "nothing to do now", not a failure');
    assert.equal(requests.length, 1, 'a message left after the hourly cap was reached');
    assert.equal(draftState(db, second.draftId), 'queued', 'the refused draft must stay queued, untouched');

    // A send from just over an hour ago is outside the window and must not be
    // counted — the cap is a rolling hour, not a calendar one.
    const before = sentThisHour(db);
    fakeSendRow(db, filler, { sentAt: Date.now() - 3_700_000 });
    assert.equal(sentThisHour(db), before, 'a send older than an hour still counts against the hourly cap');
  });

  test('outreach the daily cap refuses before the gateway is ever reached', async () => {
    const db = getDb();
    const target = seed(db, 'dayblock');
    await patchSettings({ sending: { perDay: sentToday(db), perHour: 200 } });

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    const res = await sendOne(db, target.draftId);
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.reason : '', /Daily limit reached/);
    assert.equal(requests.length, 0);
    assert.equal(
      get(db, 'SELECT id FROM send WHERE draft_id = ?', target.draftId),
      undefined,
      'a capped send must not leave a ledger row behind',
    );
    assert.equal(draftState(db, target.draftId), 'queued');
  });

  test("outreach yesterday's sends do not consume today's allowance", async () => {
    const db = getDb();
    const owner = seed(db, 'yesterday', 'draft');
    const before = sentToday(db);
    fakeSendRow(db, owner, { sentAt: startOfLocalDay() - 1, createdAt: startOfLocalDay() - 1 });
    assert.equal(sentToday(db), before, 'a send from before local midnight was counted against today');
  });

  test('outreach a failed send does not consume a slot, but an in-flight claim does', async () => {
    const db = getDb();
    const owner = seed(db, 'inflight', 'draft');
    const target = seed(db, 'inflighttarget');

    const beforeToday = sentToday(db);
    fakeSendRow(db, owner, { sentAt: Date.now(), outcome: 'failed' });
    assert.equal(sentToday(db), beforeToday, 'a failed send burned a slot it never used');

    // A 'pending' row is a claim another caller is mid-flight on. sentToday
    // cannot see it (sent_at is still null), so the top-of-function check
    // passes and the in-claim re-check is the only thing standing between two
    // callers and a double-spent slot.
    await patchSettings({ sending: { perDay: sentToday(db) + 1, perHour: 200 } });
    fakeSendRow(db, owner, { sentAt: null, outcome: 'pending', createdAt: Date.now() });

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);
    const res = await sendOne(db, target.draftId);

    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.reason : '', /limit reached/i);
    assert.equal(requests.length, 0, 'an in-flight claim did not hold its slot');
    assert.equal(draftState(db, target.draftId), 'queued', 'the cap-blocked draft was claimed anyway');

    run(db, `UPDATE send SET outcome = 'failed' WHERE outcome = 'pending'`);
  });

  test('outreach a restart does not hand back a fresh daily allowance', async () => {
    const db = getDb();
    const owner = seed(db, 'restart', 'draft');
    const target = seed(db, 'restarttarget');

    for (let i = 0; i < 3; i++) fakeSendRow(db, owner, { sentAt: Date.now() });
    const spent = sentToday(db);
    await patchSettings({ sending: { perDay: spent, perHour: 200 } });

    // What a relaunch actually does: reconcile the orphaned claims, then arm
    // the sender. Neither may reset the day's accounting, because the day's
    // accounting is derived from the send table and never held in memory.
    fakeSendRow(db, owner, { sentAt: null, outcome: 'pending', createdAt: Date.now() });
    const reconciled = reconcileInterruptedSends(db);
    assert.ok(reconciled >= 1, 'the interrupted claim was not reconciled');
    startSending(db);
    pauseSending(db);

    assert.equal(sentToday(db), spent, 'the daily count moved across a restart');
    const stats = getSendStats(db);
    assert.equal(stats.today, spent);
    assert.equal(stats.dailyLimit, spent);

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);
    const res = await sendOne(db, target.draftId);
    assert.equal(res.ok, false, 'a restart handed back a spent daily allowance');
    assert.match(!res.ok ? res.reason : '', /Daily limit reached/);
    assert.equal(requests.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The window
// ─────────────────────────────────────────────────────────────────────────────

/** The nearest date with the given local weekday, at the given local time. */
function dayAt(weekday: number, hh: number, mm: number): Date {
  const d = new Date(2026, 6, 20, hh, mm, 0, 0); // Mon 20 Jul 2026, local
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
  assert.equal(d.getDay(), weekday, 'weekday fixture is wrong');
  return d;
}

const MON = 1;
const SAT = 6;
const SUN = 0;

describe('outreach governor: the sending window', () => {
  test('outreach the window is start-inclusive and end-exclusive', async () => {
    await patchSettings({ sending: { windowStart: '09:00', windowEnd: '17:00', weekends: false } });

    assert.equal(isInSendWindow(dayAt(MON, 8, 59)), false, 'sent one minute before the window opened');
    assert.equal(isInSendWindow(dayAt(MON, 9, 0)), true, 'the opening minute must be usable');
    assert.equal(isInSendWindow(dayAt(MON, 16, 59)), true);
    assert.equal(isInSendWindow(dayAt(MON, 17, 0)), false, 'the closing minute must already be shut');
    assert.equal(isInSendWindow(dayAt(MON, 23, 30)), false);
    assert.equal(isInSendWindow(dayAt(MON, 3, 0)), false);
  });

  test('outreach a window that wraps past midnight is treated as two ranges', async () => {
    await patchSettings({ sending: { windowStart: '22:00', windowEnd: '06:00', weekends: true } });

    assert.equal(isInSendWindow(dayAt(MON, 22, 0)), true);
    assert.equal(isInSendWindow(dayAt(MON, 23, 59)), true);
    assert.equal(isInSendWindow(dayAt(MON, 5, 59)), true, 'the pre-dawn half of a wrapping window was lost');
    assert.equal(isInSendWindow(dayAt(MON, 6, 0)), false);
    assert.equal(isInSendWindow(dayAt(MON, 12, 0)), false);
  });

  test('outreach the weekend flag is respected in both directions', async () => {
    await patchSettings({ sending: { windowStart: '09:00', windowEnd: '17:00', weekends: false } });
    assert.equal(isInSendWindow(dayAt(SAT, 10, 0)), false, 'Saturday sent with weekends off');
    assert.equal(isInSendWindow(dayAt(SUN, 10, 0)), false, 'Sunday sent with weekends off');
    assert.equal(isInSendWindow(dayAt(MON, 10, 0)), true);

    await patchSettings({ sending: { weekends: true } });
    assert.equal(isInSendWindow(dayAt(SAT, 10, 0)), true, 'weekends were enabled and still refused');
    assert.equal(isInSendWindow(dayAt(SUN, 10, 0)), true);
    // The weekend flag opens the day, not the clock.
    assert.equal(isInSendWindow(dayAt(SAT, 3, 0)), false, 'a weekend send escaped the hour window');

    await patchSettings({ sending: { weekends: false } });
  });

  test('outreach getSendStats reports the window the sender is actually using', async () => {
    const db = getDb();
    await patchSettings({ sending: { windowStart: '08:30', windowEnd: '18:15', perHour: 20, perDay: 150 } });
    const stats = getSendStats(db);
    assert.equal(stats.windowStart, '08:30');
    assert.equal(stats.windowEnd, '18:15');
    assert.equal(stats.hourlyLimit, 20);
    assert.equal(stats.dailyLimit, 150);
    assert.equal(stats.inWindow, isInSendWindow());
    assert.equal(stats.running, false);
    await patchSettings({ sending: { windowStart: '09:00', windowEnd: '17:00' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pacing
// ─────────────────────────────────────────────────────────────────────────────

describe('outreach governor: pacing', () => {
  test('outreach queued slots are spaced by the interval perHour implies', async () => {
    const db = getDb();
    await patchSettings({ sending: { perHour: 20, perDay: 150 } });
    const a = seed(db, 'pacea', 'draft');
    const b = seed(db, 'paceb', 'draft');

    queueDraft(db, a.draftId);
    queueDraft(db, b.draftId);

    const at = (id: string) =>
      get<{ scheduled_at: number }>(db, 'SELECT scheduled_at FROM draft WHERE id = ?', id)!.scheduled_at;
    const gap = at(b.draftId) - at(a.draftId);

    // 3,600,000 / 20 = 180,000ms. The slot is the base interval; jitter is
    // applied at send time, not to the displayed schedule.
    assert.equal(gap, 180_000, `expected a 3-minute slot at 20/hour, got ${gap}ms`);
    assert.ok(at(a.draftId) > Date.now(), 'the first slot must be in the future');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The suppression barrier, from the queue's side
// ─────────────────────────────────────────────────────────────────────────────

describe('outreach governor: nothing suppressed is selectable', () => {
  test('outreach a suppressed domain vanishes from the queue query entirely', async () => {
    const db = getDb();
    const target = seed(db, 'supdomain');
    const before = queuedCount(db);
    assert.ok(before >= 1);

    run(
      db,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('domain', ?, 'existing_client', ?)`,
      target.domain,
      Date.now(),
    );

    assert.equal(queuedCount(db), before - 1, 'a suppressed draft is still counted as queued');

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);
    // Asking for this exact draft by id is the strongest form of the question:
    // even a direct Send-now cannot reach it, because the predicate is inside
    // the selection query rather than layered on top of it.
    const res = await sendOne(db, target.draftId);
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.reason : '', /Nothing sendable/);
    assert.equal(requests.length, 0, 'a suppressed address was handed to the gateway');
  });

  test('outreach a suppressed address cannot be re-queued after the fact', async () => {
    const db = getDb();
    const target = seed(db, 'supemail', 'draft');
    run(
      db,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('email', ?, 'opt_out', ?)`,
      target.email,
      Date.now(),
    );
    assert.throws(() => queueDraft(db, target.draftId), /cannot be queued/);
    assert.equal(draftState(db, target.draftId), 'draft');
  });

  test('outreach an unread reply blocks every further send to that person', async () => {
    const db = getDb();
    const target = seed(db, 'unread');
    const sendId = fakeSendRow(db, target, { sentAt: Date.now() });
    run(
      db,
      `INSERT INTO inbound (id, gmail_id, send_id, from_email, subject, kind, handled, received_at)
       VALUES (?, ?, ?, ?, 'Re: your search', 'reply', 0, ?)`,
      ulid(),
      `g-inbound-${sendId}`,
      sendId,
      target.email,
      Date.now(),
    );

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);

    // Sending is automated; reading a "please stop" is human. Until the
    // operator has actually handled the reply, this contact is untouchable.
    const blocked = await sendOne(db, target.draftId);
    assert.equal(blocked.ok, false);
    assert.match(!blocked.ok ? blocked.reason : '', /Nothing sendable/);
    assert.equal(requests.length, 0);

    run(db, `UPDATE inbound SET handled = 1 WHERE send_id = ?`, sendId);
    const allowed = await sendOne(db, target.draftId);
    assert.equal(allowed.ok, true, `handling the reply must release the contact: ${JSON.stringify(allowed)}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.to, target.email, 'the recipient must come from the contact row');
  });

  test('outreach a bounced or rejected contact is unreachable even while queued', async () => {
    const db = getDb();
    for (const status of ['bounced', 'rejected'] as const) {
      const target = seed(db, `status-${status}`);
      run(db, 'UPDATE contact SET status = ? WHERE id = ?', status, target.contactId);

      const { gateway, requests } = fakeGateway();
      __setSendGatewayForTests(gateway);
      const res = await sendOne(db, target.draftId);
      assert.equal(res.ok, false, `a ${status} contact was sent to`);
      assert.equal(requests.length, 0);
    }
  });

  test('outreach a disqualified or un-approved company pulls its drafts out of the queue', async () => {
    const db = getDb();
    const dq = seed(db, 'disqualified');
    run(db, `UPDATE company SET disqualified = 'agency' WHERE id = ?`, dq.companyId);

    const unapproved = seed(db, 'unapproved');
    run(db, `UPDATE company SET status = 'scored' WHERE id = ?`, unapproved.companyId);

    const { gateway, requests } = fakeGateway();
    __setSendGatewayForTests(gateway);
    for (const t of [dq, unapproved]) {
      const res = await sendOne(db, t.draftId);
      assert.equal(res.ok, false);
      assert.match(!res.ok ? res.reason : '', /Nothing sendable/);
    }
    assert.equal(requests.length, 0);
  });
});
