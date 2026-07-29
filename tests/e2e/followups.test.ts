/**
 * The round-2 additions: follow-up bumps, unqueue, scoped export, test-send.
 *
 * Also proves the v1 → v2 migration path: v2 relaxes the one-draft-per-contact
 * unique index to ACTIVE states (draft/queued/sending) and adds
 * draft.follow_up_of — without it a contact could never receive a second
 * message, which made follow-ups structurally impossible.
 */

// Must come first: patches require('electron').
import { installElectronStub, invokeHandler, makeFakeWindow } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import schemaSql from '../../src/main/db/schema.sql';
import { initDb, closeDb, getDb, get, all, run, ulid, type Db } from '../../src/main/db/index.js';
import { registerIpc } from '../../src/main/ipc/index.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';
import { FOLLOW_UP_MIN_AGE_MS } from '../../src/main/pipeline/drafts.js';
import type { SentRow, DraftRow } from '../../src/shared/ipc.js';

installElectronStub();

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-followups-'));
  initDb(path.join(tmpRoot, 'followups.db'));
  registerIpc(makeFakeWindow() as never);
});

after(() => {
  closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

function seedCompany(db: Db, name: string, domain: string): string {
  const id = upsertCompany(db, { name, domain });
  run(db, `UPDATE company SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now(), id);
  run(
    db,
    `INSERT INTO req (company_id, external_id, source, title, location, url, first_seen_at, last_seen_at)
     VALUES (?, ?, 'greenhouse', 'Platform Engineer', 'SF', 'https://example.test/j', ?, ?)`,
    id,
    `req-${name}`,
    Date.now() - 30 * 86_400_000,
    Date.now(),
  );
  return id;
}

function seedContact(db: Db, companyId: string, email: string): string {
  const id = ulid();
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
     VALUES (?, ?, 'Grace Hopper', 'Grace', ?, 'approved')`,
    id,
    companyId,
    email,
  );
  return id;
}

/** A draft that already went out, with the Gmail ids a follow-up threads onto. */
function seedSentDraft(
  db: Db,
  companyId: string,
  contactId: string,
  opts: { sentAgoMs?: number; outcome?: string } = {},
): { draftId: string; sendId: string } {
  const draftId = ulid();
  run(
    db,
    `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 'Your search', 'Original body', 'sent')`,
    draftId,
    companyId,
    contactId,
  );
  const sendId = ulid();
  const sentAt = Date.now() - (opts.sentAgoMs ?? 3 * 86_400_000);
  run(
    db,
    `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, sent_at,
                       gmail_id, gmail_thread_id, message_id, created_at)
     VALUES (?, ?, ?, ?, (SELECT email FROM contact WHERE id = ?), 'Your search', 'Original body', ?, ?,
             'g-id', 'thread-123', '<orig@mail.example>', ?)`,
    sendId,
    draftId,
    companyId,
    contactId,
    contactId,
    opts.outcome ?? 'sent',
    sentAt,
    sentAt,
  );
  return { draftId, sendId };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('migration v2 upgrade path', () => {
  test('a v1 database gains follow_up_of and the relaxed active-only index', () => {
    const file = path.join(tmpRoot, 'upgrade.db');
    const v1 = new DatabaseSync(file);
    v1.exec(schemaSql);
    v1.exec('PRAGMA user_version = 1');
    v1.close();

    initDb(file); // runs the v2 delta
    const db = getDb();

    const cols = all<{ name: string }>(db, `SELECT name FROM pragma_table_info('draft')`).map((c) => c.name);
    assert.ok(cols.includes('follow_up_of'), 'v2 adds draft.follow_up_of');

    // The relaxed index: a sent draft plus a NEW active draft for the same
    // contact must now coexist — under v1 the second insert threw.
    const companyId = seedCompany(db, 'Upgrade Co', 'upgrade-mig.test');
    const contactId = seedContact(db, companyId, 'g@upgrade-mig.test');
    run(db, `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 's', 'b', 'sent')`, ulid(), companyId, contactId);
    assert.doesNotThrow(() =>
      run(db, `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 's2', 'b2', 'draft')`, ulid(), companyId, contactId),
    );
    // But two ACTIVE drafts still violate it.
    assert.throws(() =>
      run(db, `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 's3', 'b3', 'queued')`, ulid(), companyId, contactId),
    );

    // Hand the shared handle back to the main test db.
    closeDb();
    initDb(path.join(tmpRoot, 'followups.db'));
  });
});

describe('follow-up bumps', () => {
  test('a sent-and-silent message gets a threaded follow-up draft', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Bump Co', 'bump-fu.test');
    const contactId = seedContact(db, companyId, 'grace@bump-fu.test');
    const { sendId } = seedSentDraft(db, companyId, contactId);

    const draft = (await invokeHandler('generateFollowUp', sendId)) as DraftRow;
    assert.equal(draft.subject, 'Re: Your search');
    assert.ok(draft.body.includes('Platform Engineer'), 'bump references the still-open role');

    const row = get<{ follow_up_of: string; state: string }>(db, 'SELECT follow_up_of, state FROM draft WHERE id = ?', draft.id);
    assert.equal(row!.follow_up_of, sendId, 'the bump is linked to the send it threads onto');
    assert.equal(row!.state, 'draft');

    const sent = (await invokeHandler('listSent')) as SentRow[];
    const mine = sent.find((s) => s.sendId === sendId)!;
    assert.equal(mine.hasActiveFollowUp, true, 'the Sent view shows the active follow-up');

    await assert.rejects(
      () => invokeHandler('generateFollowUp', sendId),
      /active draft/i,
      'a second bump while one is active is refused',
    );
  });

  test('an active follow-up cannot be regenerated into a cold pitch — force included', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Regen Guard Co', 'regen-guard-fu.test');
    const contactId = seedContact(db, companyId, 'rg@regen-guard-fu.test');
    const { sendId } = seedSentDraft(db, companyId, contactId);
    await invokeHandler('generateFollowUp', sendId);

    await assert.rejects(() => invokeHandler('generateDraft', companyId, contactId), /follow-up exists/i);
    await assert.rejects(() => invokeHandler('generateDraft', companyId, contactId, true), /follow-up exists/i);
  });

  test('composing for an already-emailed person routes to the follow-up flow; force overrides', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Sent Guard Co', 'sent-guard-fu.test');
    const contactId = seedContact(db, companyId, 'sg@sent-guard-fu.test');
    seedSentDraft(db, companyId, contactId);

    await assert.rejects(
      () => invokeHandler('generateDraft', companyId, contactId),
      /Follow up on the Sent tab/,
      'a plain compose must not produce a second unthreaded cold email',
    );
    const forced = (await invokeHandler('generateDraft', companyId, contactId, true)) as DraftRow;
    assert.ok(forced.id, 'force is the deliberate override and creates a fresh draft');
  });

  test('a contact who replied anywhere, a failed bump, and a full chain all refuse', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Person Guard Co', 'person-guard-fu.test');

    // Replied contact — even though THIS send is 'silent'.
    const c1 = seedContact(db, companyId, 'p1@person-guard-fu.test');
    const s1 = seedSentDraft(db, companyId, c1, { outcome: 'silent' });
    run(db, `UPDATE contact SET status = 'replied' WHERE id = ?`, c1);
    await assert.rejects(() => invokeHandler('generateFollowUp', s1.sendId), /already replied/i);

    // Failed bump owns the slot.
    const c2 = seedContact(db, companyId, 'p2@person-guard-fu.test');
    const s2 = seedSentDraft(db, companyId, c2);
    const bumpId = ulid();
    run(
      db,
      `INSERT INTO draft (id, company_id, contact_id, subject, body, state, follow_up_of) VALUES (?, ?, ?, 's', 'b', 'failed', ?)`,
      bumpId,
      companyId,
      c2,
      s2.sendId,
    );
    await assert.rejects(() => invokeHandler('generateFollowUp', s2.sendId), /failed follow-up/i);

    // Two delivered bumps = ceiling.
    const c3 = seedContact(db, companyId, 'p3@person-guard-fu.test');
    const s3 = seedSentDraft(db, companyId, c3);
    for (let i = 0; i < 2; i++) {
      const bd = ulid();
      run(
        db,
        `INSERT INTO draft (id, company_id, contact_id, subject, body, state, follow_up_of) VALUES (?, ?, ?, 's', 'b', 'sent', ?)`,
        bd,
        companyId,
        c3,
        s3.sendId,
      );
      run(
        db,
        `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, sent_at, created_at)
         VALUES (?, ?, ?, ?, 'p3@person-guard-fu.test', 's', 'b', 'silent', ?, ?)`,
        ulid(),
        bd,
        companyId,
        c3,
        Date.now() - 3 * 86_400_000,
        Date.now(),
      );
    }
    await assert.rejects(() => invokeHandler('generateFollowUp', s3.sendId), /Two follow-ups/i);
  });

  test('skipDraft refuses sent and sending drafts', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Skip Guard Co', 'skip-guard-fu.test');
    const contactId = seedContact(db, companyId, 'sk@skip-guard-fu.test');
    const sent = seedSentDraft(db, companyId, contactId);
    await assert.rejects(() => invokeHandler('skipDraft', sent.draftId), /sent draft cannot be skipped/i);

    const c2 = seedContact(db, companyId, 'sk2@skip-guard-fu.test');
    const sendingId = ulid();
    run(
      db,
      `INSERT INTO draft (id, company_id, contact_id, subject, body, state) VALUES (?, ?, ?, 's', 'b', 'sending')`,
      sendingId,
      companyId,
      c2,
    );
    await assert.rejects(
      () => invokeHandler('skipDraft', sendingId),
      /sending draft cannot be skipped/i,
      'a mid-flight draft must not be skippable out from under its Gmail call',
    );
  });

  test('replied, bounced, and too-recent sends are refused with reasons', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Guard Co', 'guard-fu.test');

    const c1 = seedContact(db, companyId, 'a@guard-fu.test');
    const replied = seedSentDraft(db, companyId, c1, { outcome: 'replied' });
    await assert.rejects(() => invokeHandler('generateFollowUp', replied.sendId), /replied/i);

    const c2 = seedContact(db, companyId, 'b@guard-fu.test');
    const bounced = seedSentDraft(db, companyId, c2, { outcome: 'bounced' });
    await assert.rejects(() => invokeHandler('generateFollowUp', bounced.sendId), /bounced/i);

    const c3 = seedContact(db, companyId, 'c@guard-fu.test');
    const fresh = seedSentDraft(db, companyId, c3, { sentAgoMs: FOLLOW_UP_MIN_AGE_MS - 60_000 });
    await assert.rejects(() => invokeHandler('generateFollowUp', fresh.sendId), /two days/i);
  });
});

describe('unqueueDraft', () => {
  test('returns a queued draft to Drafts and refuses anything else', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Unq Co', 'unq-fu.test');
    const contactId = seedContact(db, companyId, 'u@unq-fu.test');
    const draftId = ulid();
    run(
      db,
      `INSERT INTO draft (id, company_id, contact_id, subject, body, state, scheduled_at) VALUES (?, ?, ?, 's', 'b', 'queued', ?)`,
      draftId,
      companyId,
      contactId,
      Date.now() + 60_000,
    );

    await invokeHandler('unqueueDraft', draftId);
    const row = get<{ state: string; scheduled_at: number | null }>(db, 'SELECT state, scheduled_at FROM draft WHERE id = ?', draftId);
    assert.equal(row!.state, 'draft');
    assert.equal(row!.scheduled_at, null);

    await assert.rejects(() => invokeHandler('unqueueDraft', draftId), /Only a queued draft/);
  });
});

describe('scoped CSV export', () => {
  test('a company-id list exports only those companies (and their contacts)', async () => {
    const db = getDb();
    const keep = seedCompany(db, 'Keep Exports Inc', 'keep-exp.test');
    seedCompany(db, 'Drop Exports Inc', 'drop-exp.test');
    seedContact(db, keep, 'k@keep-exp.test');

    const companiesFile = (await invokeHandler('exportCsv', 'companies', [keep])) as string;
    const companiesCsv = fs.readFileSync(companiesFile, 'utf8');
    assert.ok(companiesCsv.includes('Keep Exports Inc'));
    assert.ok(!companiesCsv.includes('Drop Exports Inc'));

    const contactsFile = (await invokeHandler('exportCsv', 'contacts', [keep])) as string;
    const contactsCsv = fs.readFileSync(contactsFile, 'utf8');
    assert.ok(contactsCsv.includes('k@keep-exp.test'));

    const allFile = (await invokeHandler('exportCsv', 'companies')) as string;
    const allCsv = fs.readFileSync(allFile, 'utf8');
    assert.ok(allCsv.includes('Drop Exports Inc'), 'omitting ids still exports everything');
  });

  test('formula-shaped values are neutralised in the CSV (Excel/Sheets injection)', async () => {
    const db = getDb();
    const evil = seedCompany(db, '=HYPERLINK("http://evil.test","click")', 'evil-csv.test');
    const file = (await invokeHandler('exportCsv', 'companies', [evil])) as string;
    const csv = fs.readFileSync(file, 'utf8');
    assert.ok(csv.includes(`'=HYPERLINK`), 'a leading = is prefixed so spreadsheets treat it as text');
    assert.ok(!/,=HYPERLINK/.test(csv), 'no bare formula cell survives');
  });
});

describe('sendTestEmail', () => {
  test('fails cleanly when Gmail is not connected — and never touches a prospect', async () => {
    const db = getDb();
    const companyId = seedCompany(db, 'Test Send Co', 'testsend-fu.test');
    const contactId = seedContact(db, companyId, 't@testsend-fu.test');
    const draftId = ulid();
    run(db, `INSERT INTO draft (id, company_id, contact_id, subject, body) VALUES (?, ?, ?, 's', 'b')`, draftId, companyId, contactId);

    const sendsBefore = get<{ n: number }>(db, 'SELECT count(*) AS n FROM send')!.n;
    await assert.rejects(() => invokeHandler('sendTestEmail', draftId), /Gmail is not connected/);
    const sendsAfter = get<{ n: number }>(db, 'SELECT count(*) AS n FROM send')!.n;
    assert.equal(sendsAfter, sendsBefore, 'a test send never creates a send-ledger row');
  });
});
