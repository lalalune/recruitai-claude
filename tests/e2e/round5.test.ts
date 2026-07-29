/**
 * Round-5 regression suite: the defects three measured audits surfaced.
 *
 *  - Unicode identity: a CJK/Cyrillic company name normalised to '' under the
 *    ASCII-only normName, so a company-name suppression STORED a row that no
 *    match arm could ever equal — a suppression that does not suppress, the
 *    exact failure class suppression.ts exists to kill. IDN domains had the
 *    same hole (unicode form vs the ASCII company.domain).
 *  - Crash windows: sendOne flips the send row to sent/failed BEFORE its
 *    bookkeeping transaction, so a kill-9 in those windows left the draft in
 *    'sending' forever — unskippable, unregenerable, its contact permanently
 *    blocked by the active-draft unique index. requeueStale's 30-minute floor
 *    wedged crashed tasks the same way; a kill-9 inside bulkLoadReqs deleted
 *    the FTS triggers permanently; orphaned 'reserved' ledger rows held spend
 *    forever.
 *  - Honesty surfaces: the verify-cost estimator quoted spend for companies
 *    the run never visits; migration v3's index set and the canonical
 *    lowercase invariant carry the measured send-path seeks.
 */

// Must come first: patches require('electron').
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  initDb,
  closeDb,
  getDb,
  openDb,
  ensureFtsTriggers,
  SCHEMA_VERSION,
  all,
  get,
  run,
  ulid,
  type Db,
} from '../../src/main/db/index.js';
import { setDataDir } from '../../src/main/settings.js';
import { upsertCompany, normName } from '../../src/main/pipeline/ingest.js';
import { canonicalCompanyValue, canonicalDomainValue } from '../../src/main/pipeline/canon.js';
import { addSuppression, exportCsv } from '../../src/main/ipc/settings.js';
import { markInbound, reconcileInterruptedSends } from '../../src/main/ipc/outreach.js';
import { requeueStale, releaseStaleReservations, totalSpentMicros } from '../../src/main/pipeline/tasks.js';
import { estimatePendingVerifications } from '../../src/main/pipeline/run.js';
import { isSuppressed } from '../../src/main/pipeline/scoring.js';

installElectronStub();

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-round5-'));
  setDataDir(tmpRoot);
  initDb(path.join(tmpRoot, 'round5.db'));
});

after(() => {
  closeDb();
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leaked CI tmpdir must not fail the suite */
  }
});

let seq = 0;

/** Approved company + approved contact + a draft in the given state. */
function seedChain(
  db: Db,
  name: string,
  domain: string | null,
  draftState: 'draft' | 'queued' | 'sending',
): { companyId: string; contactId: string; draftId: string; email: string } {
  seq += 1;
  const companyId = upsertCompany(db, { name, domain: domain ?? undefined });
  run(db, `UPDATE company SET status = 'approved', updated_at = ? WHERE id = ?`, Date.now(), companyId);
  const contactId = ulid();
  const email = `lead${seq}@${domain ?? `r5-${seq}.fallback.test`}`;
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
     VALUES (?, ?, 'Riley Lead', 'Riley', ?, 'approved')`,
    contactId,
    companyId,
    email,
  );
  const draftId = ulid();
  run(
    db,
    `INSERT INTO draft (id, company_id, contact_id, subject, body, template, state, created_at, updated_at)
     VALUES (?, ?, ?, 'Subject', 'Body', 'test', ?, ?, ?)`,
    draftId,
    companyId,
    contactId,
    draftState,
    Date.now(),
    Date.now(),
  );
  return { companyId, contactId, draftId, email };
}

function insertSend(
  db: Db,
  c: { companyId: string; contactId: string; draftId: string; email: string },
  outcome: 'pending' | 'sent' | 'failed',
): string {
  const sendId = ulid();
  run(
    db,
    `INSERT INTO send (id, draft_id, company_id, contact_id, to_email, subject, body, outcome, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, 'Subject', 'Body', ?, ?, ?)`,
    sendId,
    c.draftId,
    c.companyId,
    c.contactId,
    c.email,
    outcome,
    Date.now(),
    outcome === 'sent' ? Date.now() : null,
  );
  return sendId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unicode identity
// ─────────────────────────────────────────────────────────────────────────────

describe('round5 unicode identity', () => {
  test('round5 normName keeps CJK, Cyrillic and Arabic letters instead of deleting them', () => {
    assert.equal(normName('株式会社テストラボ'), '株式会社テストラボ');
    assert.equal(normName('ООО Яндекс'), 'ооо яндекс');
    assert.notEqual(normName('شركة الاختبار'), '');
    // Latin behaviour unchanged: diacritics fold, legal suffixes strip.
    assert.equal(normName('Café Labs, Inc.'), 'cafe labs');
    assert.equal(normName('Node.js'), 'node js');
  });

  test('round5 a company-name suppression in CJK actually suppresses (measured no-op before)', () => {
    const db = getDb();
    const chain = seedChain(db, '株式会社テストラボ', 'testlab-r5.example', 'queued');

    addSuppression(db, 'company', '株式会社テストラボ', 'manual');

    const co = get<{ status: string }>(db, 'SELECT status FROM company WHERE id = ?', chain.companyId);
    assert.equal(co?.status, 'suppressed', 'the company row must flip');
    const draft = get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', chain.draftId);
    assert.equal(draft?.state, 'skipped', 'the queued draft must be pulled');
    assert.equal(isSuppressed(db, chain.companyId, 'testlab-r5.example'), true);
  });

  test('round5 scoring.isSuppressed now sees name-kind company suppressions', () => {
    const db = getDb();
    const chain = seedChain(db, 'Nordwind Analytics', null, 'draft');
    addSuppression(db, 'company', 'Nordwind Analytics', 'manual');
    assert.equal(isSuppressed(db, chain.companyId, null), true);
  });

  test('round5 unicode IDN domains store as punycode so they can match company.domain', () => {
    assert.equal(canonicalDomainValue('BÜCHER.de'), 'xn--bcher-kva.de');
    assert.equal(canonicalDomainValue('acme.com'), 'acme.com');
    // company-kind values shaped as domains take the same conversion.
    assert.equal(canonicalCompanyValue('bücher.de'), 'xn--bcher-kva.de');
  });

  test('round5 CSV exports carry a UTF-8 BOM so Excel does not mojibake CJK names', () => {
    const db = getDb();
    const file = exportCsv(db, 'companies');
    const head = fs.readFileSync(file, 'utf8');
    assert.equal(head.charCodeAt(0), 0xfeff, 'first code unit must be the BOM');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Crash recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('round5 crash recovery', () => {
  test('round5 a draft wedged in sending with a SENT row recovers as sent + contacted', () => {
    const db = getDb();
    const chain = seedChain(db, 'Wedge Sent Co', 'wedge-sent.example', 'sending');
    insertSend(db, chain, 'sent');

    reconcileInterruptedSends(db);

    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', chain.draftId)?.state, 'sent');
    assert.equal(
      get<{ status: string }>(db, 'SELECT status FROM contact WHERE id = ?', chain.contactId)?.status,
      'contacted',
      'the delivered message must mark the contact contacted, exactly like the success path',
    );
  });

  test('round5 a draft wedged in sending with a FAILED row recovers as failed', () => {
    const db = getDb();
    const chain = seedChain(db, 'Wedge Failed Co', 'wedge-failed.example', 'sending');
    insertSend(db, chain, 'failed');

    reconcileInterruptedSends(db);

    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', chain.draftId)?.state, 'failed');
  });

  test('round5 a sending draft with no send row at all is not left wedged', () => {
    const db = getDb();
    const chain = seedChain(db, 'Wedge Orphan Co', 'wedge-orphan.example', 'sending');

    reconcileInterruptedSends(db);

    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', chain.draftId)?.state, 'failed');
  });

  test('round5 the pending sweep still marks unconfirmed sends failed', () => {
    const db = getDb();
    const chain = seedChain(db, 'Wedge Pending Co', 'wedge-pending.example', 'sending');
    const sendId = insertSend(db, chain, 'pending');

    reconcileInterruptedSends(db);

    assert.equal(get<{ outcome: string }>(db, 'SELECT outcome FROM send WHERE id = ?', sendId)?.outcome, 'failed');
    assert.equal(get<{ state: string }>(db, 'SELECT state FROM draft WHERE id = ?', chain.draftId)?.state, 'failed');
  });

  test('round5 requeueStale with floor 0 recovers a task that crashed minutes ago', () => {
    const db = getDb();
    run(
      db,
      `INSERT INTO task (kind, payload, state, started_at) VALUES ('draft_generation', '{}', 'running', ?)`,
      Date.now() - 5 * 60_000,
    );
    assert.equal(requeueStale(db, 30 * 60_000), 0, 'the 30-minute floor cannot see a 5-minute-old crash');
    assert.equal(requeueStale(db, 0), 1, 'floor 0 must recover it');
    const states = all<{ state: string }>(db, `SELECT state FROM task WHERE kind = 'draft_generation'`);
    assert.ok(states.every((r) => r.state === 'pending'));
  });

  test('round5 missing FTS triggers are recreated and the index resynced at open', () => {
    const db = getDb();
    // Simulate the kill-9-inside-bulkLoadReqs aftermath.
    db.exec('DROP TRIGGER req_ai; DROP TRIGGER req_au; DROP TRIGGER req_ad;');
    const companyId = upsertCompany(db, { name: 'Trigger Gap Co', domain: 'trigger-gap.example' });
    run(
      db,
      `INSERT INTO req (company_id, external_id, source, title, url, first_seen_at, last_seen_at)
       VALUES (?, 'gap-1', 'greenhouse', 'Xylophone Wrangler', 'https://x.example/j', ?, ?)`,
      companyId,
      Date.now(),
      Date.now(),
    );
    const misses =
      get<{ n: number }>(db, `SELECT count(*) AS n FROM req_fts WHERE req_fts MATCH 'xylophone'`)?.n ?? 0;
    assert.equal(misses, 0, 'with triggers gone the new req must be invisible to FTS');

    ensureFtsTriggers(db);

    const triggers =
      get<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('req_ai','req_au','req_ad')`,
      )?.n ?? 0;
    assert.equal(triggers, 3);
    const hits = get<{ n: number }>(db, `SELECT count(*) AS n FROM req_fts WHERE req_fts MATCH 'xylophone'`)?.n ?? 0;
    assert.equal(hits, 1, 'the resync must index rows written while triggers were missing');
  });

  test('round5 orphaned reserved ledger rows release at startup and stop counting as spend', () => {
    const db = getDb();
    run(
      db,
      `INSERT INTO api_call (provider, endpoint, idempotency_key, state, est_cost_micros)
       VALUES ('reoon', '/verify', 'round5-orphan-1', 'reserved', 40000)`,
    );
    const before = totalSpentMicros(db);
    assert.ok(before >= 40000, 'a reserved row must count against the cap while live');

    const released = releaseStaleReservations(db);

    assert.ok(released >= 1);
    assert.equal(
      get<{ state: string }>(db, `SELECT state FROM api_call WHERE idempotency_key = 'round5-orphan-1'`)?.state,
      'failed',
    );
    assert.equal(totalSpentMicros(db), before - 40000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration v3 + the honest estimator
// ─────────────────────────────────────────────────────────────────────────────

describe('round5 migration v3', () => {
  test('round5 v3 creates the measured hot-path indexes', () => {
    const db = getDb();
    const names = all<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='index'`).map((r) => r.name);
    for (const idx of ['send_contact', 'inbound_unhandled', 'send_to_email', 'field_observation_evidence', 'api_call_spend']) {
      assert.ok(names.includes(idx), `missing index: ${idx}`);
    }
  });

  test('round5 upgrading a v2 database lowercases legacy suppression values and repairs name_norm', () => {
    const file = path.join(tmpRoot, 'v2-legacy.db');
    const v2 = openDb(file);
    // Rewind to v2: drop everything v3, v4 and v5 added, then plant
    // legacy-shaped rows — an uppercase suppression value (pre-invariant) and
    // the name_norm the old ASCII normName produced for a CJK company (empty
    // string). Every new migration that creates an index must be listed here.
    v2.exec(`DROP INDEX send_contact; DROP INDEX inbound_unhandled; DROP INDEX send_to_email;
             DROP INDEX field_observation_evidence; DROP INDEX api_call_spend;
             DROP INDEX raw_source_url;
             DROP INDEX contact_email_domain; DROP INDEX fo_email_domain;`);
    run(
      v2,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('domain', 'ACME.EXAMPLE', 'manual', ?)`,
      Date.now(),
    );
    run(
      v2,
      `INSERT INTO company (id, name, name_norm, status, created_at, updated_at)
       VALUES ('01ROUND5LEGACYAAAAAAAAAAAA', '株式会社レガシー', '', 'discovered', ?, ?)`,
      Date.now(),
      Date.now(),
    );
    run(
      v2,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('company', '株式会社レガシー', 'manual', ?)`,
      Date.now(),
    );
    v2.exec('PRAGMA user_version = 2');
    v2.close();

    const upgraded = openDb(file);
    try {
      assert.equal(get<{ user_version: number }>(upgraded, 'PRAGMA user_version')?.user_version, SCHEMA_VERSION);
      assert.equal(
        get<{ value: string }>(upgraded, `SELECT value FROM suppression WHERE kind = 'domain' AND value = 'acme.example'`)
          ?.value,
        'acme.example',
        'v3 must lowercase legacy values so bare seeks keep matching',
      );
      assert.equal(
        get<{ name_norm: string }>(upgraded, `SELECT name_norm FROM company WHERE id = '01ROUND5LEGACYAAAAAAAAAAAA'`)
          ?.name_norm,
        '株式会社レガシー',
        'the backfill must recompute name_norm with the Unicode normName',
      );
      const supValues = all<{ value: string }>(upgraded, `SELECT value FROM suppression WHERE kind = 'company'`).map(
        (r) => r.value,
      );
      assert.ok(
        supValues.includes('株式会社レガシー'),
        'the stored company suppression must be re-canonicalised to match the new name_norm',
      );
      const indexes = all<{ name: string }>(upgraded, `SELECT name FROM sqlite_master WHERE type='index'`).map(
        (r) => r.name,
      );
      assert.ok(indexes.includes('send_contact'));
    } finally {
      upgraded.close();
    }
  });
});

describe('round5 the spend estimator mirrors the run', () => {
  test('round5 contacts at un-gated companies estimate zero (the run never visits them)', () => {
    const db = getDb();
    const chain = seedChain(db, 'Lowscore Verify Co', 'lowscore-verify.example', 'draft');
    run(
      db,
      `UPDATE company SET status = 'scored', quality_score = 4, updated_at = ? WHERE id = ?`,
      Date.now(),
      chain.companyId,
    );
    run(db, `UPDATE contact SET email_verdict = 'unverified' WHERE id = ?`, chain.contactId);

    // Isolate: nothing else seeded in this suite passes the gate.
    assert.equal(estimatePendingVerifications(db, 183), 0);
  });

  test('round5 a gated company estimates addresses plus pattern-aware candidates', () => {
    const db = getDb();
    const chain = seedChain(db, 'Gated Verify Co', 'gated-verify.example', 'draft');
    run(
      db,
      `UPDATE company SET status = 'scored', quality_score = 8, updated_at = ? WHERE id = ?`,
      Date.now(),
      chain.companyId,
    );
    run(db, `UPDATE contact SET email_verdict = 'unverified' WHERE id = ?`, chain.contactId);
    // A second contact with no address: 2 candidates without a pattern…
    run(
      db,
      `INSERT INTO contact (id, company_id, full_name, first_name, status)
       VALUES (?, ?, 'Alex NoMail', 'Alex', 'candidate')`,
      ulid(),
      chain.companyId,
    );

    assert.equal(estimatePendingVerifications(db, 183), 3, '1 unverified address + 2 pattern-less candidates');

    // …and 1 once the domain's pattern is known.
    run(
      db,
      `INSERT INTO email_pattern (domain, pattern, sample_count, confidence) VALUES ('gated-verify.example', 'first', 1, 0.9)`,
    );
    assert.equal(estimatePendingVerifications(db, 183), 2, 'a known pattern halves the candidate spend');

    // Cleanup so other tests' isolation holds.
    run(db, `UPDATE company SET quality_score = NULL, status = 'discovered' WHERE id = ?`, chain.companyId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markInbound tells the truth
// ─────────────────────────────────────────────────────────────────────────────

describe('round5 markInbound reports real suppression scope', () => {
  function inboundFor(db: Db, sendId: string, from: string): string {
    const id = ulid();
    run(
      db,
      `INSERT INTO inbound (id, gmail_id, send_id, from_email, kind, received_at)
       VALUES (?, ?, ?, ?, 'reply', ?)`,
      id,
      `g-${id}`,
      sendId,
      from,
      Date.now(),
    );
    return id;
  }

  test('round5 a corporate "no" reports domain scope and undoable row ids', () => {
    const db = getDb();
    const chain = seedChain(db, 'Corp Reply Co', 'corp-reply.example', 'draft');
    run(db, `UPDATE draft SET state = 'sent' WHERE id = ?`, chain.draftId);
    const sendId = insertSend(db, chain, 'sent');
    const inboundId = inboundFor(db, sendId, chain.email);

    const result = markInbound(db, inboundId, 'negative');

    assert.equal(result.suppressed?.kind, 'domain');
    assert.equal(result.suppressed?.value, 'corp-reply.example');
    assert.ok((result.suppressed?.ids.length ?? 0) >= 1);
    const stored = get<{ id: number }>(
      db,
      `SELECT id FROM suppression WHERE kind = 'domain' AND value = 'corp-reply.example'`,
    );
    assert.equal(stored?.id, result.suppressed?.ids[0], 'the ids must be the real rows, so Undo can target them');
  });

  test('round5 a freemail "no" reports address-only scope (the carve-out the old toast lied about)', () => {
    const db = getDb();
    const chain = seedChain(db, 'Freemail Reply Co', 'freemail-reply.example', 'draft');
    // The recipient personally uses gmail; the company row is separate.
    run(db, `UPDATE contact SET email = 'founder-r5@gmail.com' WHERE id = ?`, chain.contactId);
    run(db, `UPDATE draft SET state = 'sent' WHERE id = ?`, chain.draftId);
    const sendId = insertSend(db, { ...chain, email: 'founder-r5@gmail.com' }, 'sent');
    const inboundId = inboundFor(db, sendId, 'founder-r5@gmail.com');

    const result = markInbound(db, inboundId, 'negative');

    assert.equal(result.suppressed?.kind, 'email');
    assert.equal(result.suppressed?.value, 'founder-r5@gmail.com');
    assert.equal(
      get<{ n: number }>(db, `SELECT count(*) AS n FROM suppression WHERE kind = 'domain' AND value = 'gmail.com'`)?.n,
      0,
      'gmail.com itself must never be suppressed',
    );
  });
});
