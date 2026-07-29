/**
 * Draft generation end to end: operator template overrides, the compliance
 * footer, and the guarantees that used to be placebo — the Settings Templates
 * editor once wrote to renderer localStorage that nothing read, while the
 * composer previewed a different opt-out line than the one that sent.
 */

// Must come first: patches require('electron').
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, run, ulid, type Db } from '../../src/main/db/index.js';
import { setDataDir, patchSettings } from '../../src/main/settings.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';
import { generateDraftFor } from '../../src/main/pipeline/drafts.js';
import { DEFAULT_OPT_OUT_LINE } from '../../src/shared/outreach.js';

installElectronStub();

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-drafts-'));
  setDataDir(tmpRoot);
  initDb(path.join(tmpRoot, 'drafts.db'));
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

function seedCompanyWithReq(db: Db, name: string, domain: string, headcount: number): { companyId: string; contactId: string } {
  const companyId = upsertCompany(db, { name, domain });
  run(
    db,
    `UPDATE company SET status = 'approved', headcount = ?, open_req_count = 1, updated_at = ? WHERE id = ?`,
    headcount,
    Date.now(),
    companyId,
  );
  run(
    db,
    `INSERT INTO req (company_id, external_id, source, title, location, url, first_seen_at, last_seen_at, published_at)
     VALUES (?, ?, 'greenhouse', 'Staff Engineer', 'San Francisco', 'https://example.test/job', ?, ?, ?)`,
    companyId,
    `req-${name}`,
    Date.now() - 40 * 86_400_000,
    Date.now(),
    Date.now() - 40 * 86_400_000,
  );
  const contactId = ulid();
  run(
    db,
    `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
     VALUES (?, ?, 'Ada Lovelace', 'Ada', ?, 'approved')`,
    contactId,
    companyId,
    `ada@${domain}`,
  );
  return { companyId, contactId };
}

describe('draft generation with settings templates', () => {
  test('built-in renderer is used when no override is set; footer carries opt-out, signature, postal', async () => {
    const db = getDb();
    await patchSettings({
      sending: { signature: 'Shaw — Bay Area Recruiting', postalAddress: '548 Market St, San Francisco, CA', includeOptOutLine: true },
    });
    const { companyId } = seedCompanyWithReq(db, 'Builtin Co', 'builtin-drafts.test', 40);

    const draft = await generateDraftFor(db, companyId, undefined, { useLlm: false });
    assert.ok(draft.subject.length > 0);
    assert.ok(draft.body.startsWith('Hi Ada,'), `body starts with greeting, got: ${draft.body.slice(0, 30)}`);
    assert.ok(draft.body.includes(DEFAULT_OPT_OUT_LINE), 'opt-out line baked in');
    assert.ok(draft.body.includes('Shaw — Bay Area Recruiting'), 'signature baked in');
    assert.ok(draft.body.includes('548 Market St'), 'postal address baked in (CAN-SPAM)');
    assert.equal(draft.template, '20_75');
  });

  test('an operator template override replaces the built-in copy with variables substituted', async () => {
    const db = getDb();
    await patchSettings({
      templates: {
        '20_75': {
          subject: 'About your {reqTitle} search',
          body: 'Hi {firstName},\n\n{companyName} has {openReqCount} roles open — the {reqTitle} caught my eye.\n\nWorth a chat?',
        },
      },
    });
    const { companyId } = seedCompanyWithReq(db, 'Override Co', 'override-drafts.test', 50);

    const draft = await generateDraftFor(db, companyId, undefined, { useLlm: false });
    assert.equal(draft.subject, 'About your Staff Engineer search');
    assert.ok(draft.body.includes('Override Co has 1 roles open — the Staff Engineer caught my eye.'));
    assert.ok(draft.generatedBy.startsWith('custom:20_75'), `generatedBy records the override: ${draft.generatedBy}`);
    assert.ok(draft.body.includes(DEFAULT_OPT_OUT_LINE), 'footer still applies to custom templates');

    // Clear the override so later tests see built-ins again.
    await patchSettings({ templates: { '20_75': { subject: '', body: '' } } });
  });

  test('regeneration never silently discards operator edits', async () => {
    const db = getDb();
    const { companyId, contactId } = seedCompanyWithReq(db, 'Edited Co', 'edited-drafts.test', 30);
    const first = await generateDraftFor(db, companyId, undefined, { useLlm: false });
    run(db, `UPDATE draft SET edited = 1, body = 'my hand-written note' WHERE id = ?`, first.id);

    await assert.rejects(
      () => generateDraftFor(db, companyId, contactId, { useLlm: false }),
      /operator edits/,
      'unforced regeneration must refuse to overwrite an edited draft',
    );
  });
});
