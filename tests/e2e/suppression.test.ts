/**
 * Suppression semantics, end to end.
 *
 * These tests exist because every leg of company-kind suppression was once
 * broken at the same time: the Settings field invited a company *name* that
 * nothing matched, stored values were lowercased while ULIDs are uppercase so
 * a pasted id never matched either, and the last-gate check before Gmail
 * skipped kind='company' entirely. A suppression that does not suppress is
 * the worst defect an outreach tool can have, so each identity (name, id,
 * domain) is asserted against each barrier here.
 */

// Must come first: patches require('electron') before any app module loads.
import { installElectronStub, invokeHandler, makeFakeWindow } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, get, all, run, ulid, type Db } from '../../src/main/db/index.js';
import { registerIpc } from '../../src/main/ipc/index.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';
import { canonicalCompanyValue } from '../../src/main/pipeline/suppression.js';
import { reconcileInterruptedSends } from '../../src/main/ipc/outreach.js';
import { assertNotSuppressed, SuppressedRecipientError } from '../../src/main/gmail/send.js';

installElectronStub();

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-suppression-'));
  initDb(path.join(tmpRoot, 'suppression.db'));
  registerIpc(makeFakeWindow() as never);
});

after(() => {
  closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seeding helpers — direct SQL, respecting every NOT NULL and CHECK.
// ─────────────────────────────────────────────────────────────────────────────

function seedCompany(db: Db, name: string, domain: string | null): string {
  const id = upsertCompany(db, { name, domain: domain ?? undefined });
  run(db, `UPDATE company SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now(), id);
  return id;
}

function seedContact(db: Db, companyId: string, email: string): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, email, status) VALUES (?, ?, ?, ?, 'approved')`,
    id,
    companyId,
    `Contact ${email}`,
    email,
  );
  return id;
}

function seedDraft(db: Db, companyId: string, contactId: string, state = 'queued'): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 'Hi', 'Body', ?)`,
    id,
    companyId,
    contactId,
    state,
  );
  return id;
}

function seedSend(db: Db, draftId: string, companyId: string, contactId: string, toEmail: string): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, 'Hi', 'Body', 'sent', ?)`,
    id,
    draftId,
    companyId,
    contactId,
    toEmail,
    Date.now(),
  );
  return id;
}

function seedInbound(db: Db, sendId: string, fromEmail: string): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO inbound (id, gmail_id, send_id, from_email, kind, received_at) VALUES (?, ?, ?, ?, 'reply', ?)`,
    id,
    `gmail-${id}`,
    sendId,
    fromEmail,
    Date.now(),
  );
  return id;
}

function draftState(db: Db, id: string): string {
  return get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', id)!.state;
}

function companyStatus(db: Db, id: string): string {
  return get<{ status: string }>(db, 'SELECT status FROM company WHERE id = ?', id)!.status;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalCompanyValue', () => {
  test('a ULID stays a ULID (lowercased), a domain stays a domain, a name is normalised', () => {
    const id = ulid();
    assert.equal(canonicalCompanyValue(id), id.toLowerCase());
    assert.equal(canonicalCompanyValue('Widget.IO'), 'widget.io');
    assert.equal(canonicalCompanyValue('Acme, Inc.'), 'acme');
    assert.equal(canonicalCompanyValue('  Möbius Labs LLC '), canonicalCompanyValue('mobius labs'));
  });
});

describe('company suppression matches every identity at every barrier', () => {
  test('by typed NAME: skips queued drafts, flips status, blocks the last gate', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Acme Inc', 'acme-name-test.com');
    const contactId = seedContact(db, companyId, 'jane@acme-name-test.com');
    const draftId = seedDraft(db, companyId, contactId);

    // The Settings field invites a name — with suffix and punctuation.
    await invokeHandler('addSuppression', 'company', 'Acme, Inc.', 'existing_client');

    assert.equal(draftState(db, draftId), 'skipped', 'queued draft must be pulled');
    assert.equal(companyStatus(db, companyId), 'suppressed');
    assert.throws(
      () => assertNotSuppressed('jane@acme-name-test.com', companyId),
      SuppressedRecipientError,
      'the last gate before Gmail must honour a name-based company suppression',
    );
  });

  test('by pasted ID: survives the operator re-approving the company', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Beta Systems', 'beta-id-test.com');
    seedContact(db, companyId, 'bo@beta-id-test.com');

    // Ids are uppercase ULIDs; storage lowercases. The barrier must still match.
    await invokeHandler('addSuppression', 'company', companyId, 'active_contract');
    assert.equal(companyStatus(db, companyId), 'suppressed');

    const stored = get<{ value: string }>(
      db,
      `SELECT value FROM suppression WHERE kind = 'company' AND value = ?`,
      companyId.toLowerCase(),
    );
    assert.ok(stored, 'value is stored lowercased');

    // Re-approve — the suppression row must keep blocking regardless of status.
    await invokeHandler('patchCompany', companyId, { status: 'approved' });
    assert.throws(
      () => assertNotSuppressed('bo@beta-id-test.com', companyId),
      SuppressedRecipientError,
      're-approval must not open a path around an active suppression row',
    );
  });

  test('by DOMAIN as a company-kind value', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Gamma Works', 'gamma-dom-test.com');
    await invokeHandler('addSuppression', 'company', 'Gamma-Dom-Test.com', 'competitor');
    assert.equal(companyStatus(db, companyId), 'suppressed');
    assert.throws(() => assertNotSuppressed('x@gamma-dom-test.com', companyId), SuppressedRecipientError);
  });

  test('removing the suppression restores the company', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Delta Robotics', 'delta-restore-test.com');
    await invokeHandler('addSuppression', 'company', 'Delta Robotics', 'manual');
    assert.equal(companyStatus(db, companyId), 'suppressed');

    const rows = (await invokeHandler('listSuppressions')) as { id: number; value: string }[];
    const mine = rows.find((r) => r.value === canonicalCompanyValue('Delta Robotics'));
    assert.ok(mine, 'suppression row exists');

    await invokeHandler('removeSuppression', mine!.id);
    assert.notEqual(
      companyStatus(db, companyId),
      'suppressed',
      'a company with no matching rule left must not stay suppressed forever',
    );
    assert.doesNotThrow(() => assertNotSuppressed('x@delta-restore-test.com', companyId));
  });
});

describe('ambiguous values, scoped restores, and CSV side effects', () => {
  test('"Node.js"-style names are stored as the reading that matches a real company', async () => {
    const db = getDb();
    // name_norm('Node.js') = 'node js'; the naive domain-shape reading
    // ('node.js') matched neither name_norm nor any domain — the suppression
    // silently suppressed nothing.
    const companyId = seedCompany(db, 'Node.js', 'nodejs-amb.test');
    await invokeHandler('addSuppression', 'company', 'Node.js', 'competitor');
    assert.equal(companyStatus(db, companyId), 'suppressed');
    assert.throws(() => assertNotSuppressed('x@nodejs-amb.test', companyId), SuppressedRecipientError);
  });

  test('removing an unrelated rule never un-suppresses a manually suppressed company', async () => {
    const db = getDb();
    const manual = seedCompany(db, 'Manual Sup Co', 'manual-sup.test');
    // Suppressed by hand — no suppression row anywhere.
    await invokeHandler('patchCompany', manual, { status: 'suppressed' });

    await invokeHandler('addSuppression', 'email', 'someone@unrelated-sup.test', 'manual');
    const rows = (await invokeHandler('listSuppressions')) as { id: number; value: string }[];
    const unrelated = rows.find((r) => r.value === 'someone@unrelated-sup.test')!;
    await invokeHandler('removeSuppression', unrelated.id);

    assert.equal(
      companyStatus(db, manual),
      'suppressed',
      'the restore sweep must be scoped to companies the removed row could have matched',
    );
  });

  test('a CSV import pulls queued drafts and flips covered companies, like manual adds do', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'CSV Sweep Co', 'csv-sweep.test');
    const contactId = seedContact(db, companyId, 'c@csv-sweep.test');
    const draftId = seedDraft(db, companyId, contactId, 'queued');

    await invokeHandler('importSuppressionsCsv', 'csv-sweep.test\n');

    assert.equal(draftState(db, draftId), 'skipped', 'queued draft for the imported domain is pulled');
    assert.equal(companyStatus(db, companyId), 'suppressed', 'covered company flips');
  });
});

describe('negative replies from freemail addresses', () => {
  test('suppress the address, never the whole freemail domain', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Epsilon AI', 'epsilon-free-test.com');
    const founder = seedContact(db, companyId, 'founder.epsilon@gmail.com');
    const founderDraft = seedDraft(db, companyId, founder, 'queued');
    const sendId = seedSend(db, founderDraft, companyId, founder, 'founder.epsilon@gmail.com');
    const inboundId = seedInbound(db, sendId, 'founder.epsilon@gmail.com');

    // A different company whose contact also lives on gmail.com.
    const otherCompany = seedCompany(db, 'Zeta Labs', 'zeta-free-test.com');
    const otherContact = seedContact(db, otherCompany, 'someone.zeta@gmail.com');
    const otherDraft = seedDraft(db, otherCompany, otherContact, 'queued');

    await invokeHandler('markInbound', inboundId, 'negative');

    const emailRow = get(db, `SELECT 1 AS x FROM suppression WHERE kind = 'email' AND value = ?`, 'founder.epsilon@gmail.com');
    const domainRow = get(db, `SELECT 1 AS x FROM suppression WHERE kind = 'domain' AND value = ?`, 'gmail.com');
    assert.ok(emailRow, 'the replying address is suppressed');
    assert.ok(!domainRow, 'gmail.com as a whole must NOT be suppressed');

    assert.equal(draftState(db, founderDraft), 'skipped', 'their own queued draft is pulled');
    assert.equal(draftState(db, otherDraft), 'queued', 'unrelated gmail.com contacts keep their drafts');
  });

  test('corporate negatives still suppress the domain', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Eta Corp', 'eta-corp-test.com');
    const contact = seedContact(db, companyId, 'ceo@eta-corp-test.com');
    const draft = seedDraft(db, companyId, contact, 'queued');
    const sendId = seedSend(db, draft, companyId, contact, 'ceo@eta-corp-test.com');
    const inboundId = seedInbound(db, sendId, 'ceo@eta-corp-test.com');

    await invokeHandler('markInbound', inboundId, 'negative');

    const domainRow = get(db, `SELECT 1 AS x FROM suppression WHERE kind = 'domain' AND value = ?`, 'eta-corp-test.com');
    assert.ok(domainRow, 'a company-domain negative suppresses the domain');
  });
});

describe('companySuppressionValues disambiguation', () => {
  test('a matching company settles the reading; a pre-emptive ambiguous entry stores BOTH', async () => {
    const db = getDb();
    const { companySuppressionValues } = await import('../../src/main/pipeline/suppression.js');
    // Real domain wins its shape — one row.
    seedCompany(db, 'Booking Co', 'booking-amb.test');
    assert.deepEqual(companySuppressionValues(db, 'Booking-Amb.Test'), ['booking-amb.test']);
    // No company anywhere and the readings differ ("Future.io" parses as a
    // domain AND normalises to the name 'future io'): we cannot know which
    // way the company will arrive, so BOTH are stored — whichever identity
    // shows up later, one row matches.
    assert.deepEqual(companySuppressionValues(db, 'Future.io').sort(), ['future io', 'future.io'].sort());
    // A spaced name is unambiguous (never domain-shaped) — one row.
    assert.deepEqual(companySuppressionValues(db, 'Future.io Labs'), ['future io labs']);
    // A bare ULID keeps its shape even when unknown — one unambiguous row.
    const id = ulid();
    assert.deepEqual(companySuppressionValues(db, id), [id.toLowerCase()]);
  });
});

describe('bounce handling', () => {
  test('marking a bounce closes the contact, suppresses the address, and stamps the send', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Kappa Bounce', 'kappa-bounce.test');
    const contactId = seedContact(db, companyId, 'gone@kappa-bounce.test');
    const draftId = seedDraft(db, companyId, contactId, 'sent');
    const sendId = seedSend(db, draftId, companyId, contactId, 'gone@kappa-bounce.test');
    run(
      db,
      `INSERT INTO inbound (id, gmail_id, send_id, from_email, kind, bounce_recipient, received_at)
       VALUES (?, ?, ?, 'mailer-daemon@googlemail.com', 'bounce', 'gone@kappa-bounce.test', ?)`,
      'IN-KAPPA',
      'g-kappa',
      sendId,
      Date.now(),
    );

    await invokeHandler('markInbound', 'IN-KAPPA', 'bounce');

    assert.equal(get<{ outcome: string }>(db, 'SELECT outcome FROM send WHERE id = ?', sendId)!.outcome, 'bounced');
    const contact = get<{ status: string; email_verdict: string }>(db, 'SELECT status, email_verdict FROM contact WHERE id = ?', contactId)!;
    assert.equal(contact.status, 'bounced');
    assert.equal(contact.email_verdict, 'invalid');
    assert.ok(
      get(db, `SELECT 1 AS x FROM suppression WHERE kind = 'email' AND value = 'gone@kappa-bounce.test'`),
      'a hard bounce is permanent — the address is suppressed',
    );
  });
});

describe('send claim and interrupted-send reconciliation', () => {
  // The claim's atomicity is proven through the REAL sendOne path in
  // tests/e2e/sendpath.test.ts ("two concurrent sendOne calls produce exactly
  // one send") — an inline copy of the UPDATE here only proved SQLite's
  // conditional-update semantics and would keep passing if sendOne dropped
  // its state guard.

  test('reconcile marks even young pending sends failed — the instance lock makes them all orphans', () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Iota Two', 'iota-reconcile-test.com');
    const contactId = seedContact(db, companyId, 'b@iota-reconcile-test.com');
    const draftId = seedDraft(db, companyId, contactId, 'sending');
    const sendId = ulid();
    run(
      db,
      `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, created_at)
       VALUES (?, ?, ?, ?, 'b@iota-reconcile-test.com', 'Hi', 'Body', 'pending', ?)`,
      sendId,
      draftId,
      companyId,
      contactId,
      Date.now(), // seconds old, not the historical 10-minute floor
    );

    const n = reconcileInterruptedSends(db);
    assert.ok(n >= 1, 'the young pending send is reconciled');
    assert.equal(get<{ outcome: string }>(db, 'SELECT outcome FROM send WHERE id = ?', sendId)!.outcome, 'failed');
    assert.equal(draftState(db, draftId), 'failed');
  });
});
