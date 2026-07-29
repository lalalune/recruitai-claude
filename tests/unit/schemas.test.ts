/**
 * IPC boundary validation.
 *
 * These tests import src/main/ipc/guard.ts on purpose: the whole point of the
 * lazy `require('electron')` in that file is that `validateChannel` stays
 * loadable in a bundle where electron is external. If someone converts it back
 * to a static import, this file fails at require time and says so loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChannel } from '../../src/main/ipc/guard.js';
import {
  CHANNEL_NAMES,
  Schemas,
  channelArity,
  companyListParamsSchema,
  companyPatchSchema,
  contactPatchSchema,
  draftPatchSchema,
  externalUrlSchema,
  idSchema,
  normaliseUrl,
  relPathSchema,
  settingsPatchSchema,
  sourceKeySchema,
  suppressionReasonSchema,
} from '../../src/shared/schemas.js';

/** Every channel on RecruitApi, plus the three LinkedIn additions. */
const EXPECTED_CHANNELS = [
  'listCompanies', 'getCompany', 'patchCompany', 'bulkCompanyStatus', 'resolveConflict',
  'patchContact', 'addContact', 'deleteContact', 'findContacts', 'verifyContact',
  'getPipeline', 'runSource', 'runAll', 'stopPipeline', 'setSourceEnabled',
  'listDrafts', 'generateDraft', 'patchDraft', 'queueDraft', 'unqueueDraft', 'skipDraft', 'sendNow', 'sendTestEmail',
  'getSendStats', 'startSending', 'pauseSending', 'listInbound', 'markInbound', 'syncInbox', 'listSent', 'getPerformance', 'generateFollowUp',
  'getSettings', 'patchSettings', 'setSecret', 'testKey', 'connectGmail', 'disconnectGmail', 'testGmail',
  'getLinkedInStatus', 'connectLinkedIn', 'disconnectLinkedIn',
  'listSuppressions', 'addSuppression', 'removeSuppression', 'importSuppressionsCsv',
  'getStats', 'exportCsv', 'backupNow', 'openDataDir', 'openExternal', 'getScreenshot',
];

const ID = '01JQ8Z9K7M4T2V6X0N3B5C8D1E';

function ok(channel: string, args: unknown[]): unknown[] {
  const r = validateChannel(channel, args);
  assert.equal(r.ok, true, `${channel} should accept ${JSON.stringify(args)} but said: ${r.error}`);
  assert.ok(Array.isArray(r.data));
  assert.equal(r.error, null);
  return r.data;
}

function bad(channel: string, args: unknown[], expectFragment?: string): string {
  const r = validateChannel(channel, args);
  assert.equal(r.ok, false, `${channel} should reject ${JSON.stringify(args)}`);
  assert.equal(r.data, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'error must be a non-empty string');
  const error = r.error as string;
  assert.ok(error.includes(channel), `message should name the channel: ${error}`);
  assert.ok(!error.includes('ZodError'), `message must not be a raw zod dump: ${error}`);
  if (expectFragment) {
    assert.ok(error.includes(expectFragment), `expected "${expectFragment}" in: ${error}`);
  }
  return error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage of the channel map
// ─────────────────────────────────────────────────────────────────────────────

test('every RecruitApi channel has an input schema', () => {
  for (const channel of EXPECTED_CHANNELS) {
    assert.ok(Object.hasOwn(Schemas, channel), `missing schema for ${channel}`);
  }
  assert.deepEqual([...CHANNEL_NAMES].sort(), [...EXPECTED_CHANNELS].sort());
});

test('unknown channels are rejected rather than waved through', () => {
  const r = validateChannel('dropAllTables', []);
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r.error, 'Unknown IPC channel: dropAllTables');
});

test('no-argument channels take no arguments', () => {
  for (const channel of ['getPipeline', 'runAll', 'getSettings', 'backupNow', 'getLinkedInStatus']) {
    assert.equal(channelArity(channel), 0);
    assert.deepEqual(ok(channel, []), []);
    bad(channel, ['surprise'], 'expected at most 0 arguments');
  }
});

test('extra positional arguments are rejected', () => {
  bad('getCompany', [ID, 'extra'], 'expected at most 1 argument, received 2');
});

test('a non-array argument list is rejected', () => {
  const r = validateChannel('getCompany', ID as unknown);
  assert.equal(r.ok, false);
  assert.ok((r.error as string).includes('expected an array'));
});

// ─────────────────────────────────────────────────────────────────────────────
// CompanyListParams
// ─────────────────────────────────────────────────────────────────────────────

test('listCompanies accepts the params the renderer actually sends', () => {
  const [params] = ok('listCompanies', [{ filter: 'all', sort: 'recent', limit: 1_000_000 }]);
  assert.deepEqual(params, { filter: 'all', sort: 'recent', limit: 1_000_000 });
});

test('listCompanies defaults to an empty params object when called bare', () => {
  assert.deepEqual(ok('listCompanies', []), [{}]);
});

test('listCompanies rejects a filter typo', () => {
  bad('listCompanies', [{ filter: 'unreviewd' }], 'arg0.filter');
});

test('listCompanies rejects a sort typo', () => {
  bad('listCompanies', [{ sort: 'quality_score' }], 'arg0.sort');
});

test('listCompanies rejects a negative limit', () => {
  bad('listCompanies', [{ limit: -1 }], 'limit cannot be negative');
  bad('listCompanies', [{ offset: -5 }], 'offset cannot be negative');
});

test('listCompanies rejects a fractional limit and an absurd one', () => {
  bad('listCompanies', [{ limit: 12.5 }], 'limit must be a whole number');
  bad('listCompanies', [{ limit: 2_000_000 }]);
});

test('listCompanies rejects a non-boolean flag and an over-long search', () => {
  bad('listCompanies', [{ hasVerifiedEmail: 'yes' }], 'arg0.hasVerifiedEmail');
  bad('listCompanies', [{ search: 'x'.repeat(201) }], 'Search is limited to 200 characters');
});

test('listCompanies rejects a search containing a control character', () => {
  bad('listCompanies', [{ search: 'acme\u0000drop' }], 'control characters');
});

test('listCompanies strips unknown keys instead of forwarding them', () => {
  const parsed = companyListParamsSchema.parse({ filter: 'all', ohNo: "'; DROP TABLE company; --" });
  assert.deepEqual(parsed, { filter: 'all' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ids
// ─────────────────────────────────────────────────────────────────────────────

test('ids accept a ULID and reject the empty string', () => {
  assert.equal(idSchema.parse(ID), ID);
  bad('getCompany', [''], 'Id cannot be empty');
});

test('an id containing a newline or a control character is rejected', () => {
  bad('getCompany', ['01JQ8Z\nDROP'], 'control characters');
  bad('deleteContact', ['01JQ8Z\u0007X'], 'control characters');
  bad('queueDraft', [`${ID}\u007f`], 'control characters');
});

test('an over-long id is rejected', () => {
  bad('verifyContact', ['A'.repeat(65)], 'Id is too long');
});

test('a missing required id reports the argument position', () => {
  bad('getCompany', [], 'arg0');
});

// ─────────────────────────────────────────────────────────────────────────────
// CompanyPatch
// ─────────────────────────────────────────────────────────────────────────────

test('patchCompany accepts a realistic operator edit', () => {
  const [id, patch] = ok('patchCompany', [
    ID,
    { headcount: 48, website: 'https://acme.com', status: 'approved', reviewed: true, notes: ' hot lead ' },
  ]);
  assert.equal(id, ID);
  assert.deepEqual(patch, {
    headcount: 48,
    website: 'https://acme.com/',
    status: 'approved',
    reviewed: true,
    notes: 'hot lead',
  });
});

test('patchCompany defaults to an empty patch and clears fields with null', () => {
  assert.deepEqual(ok('patchCompany', [ID]), [ID, {}]);
  const [, patch] = ok('patchCompany', [ID, { headcount: null, industry: '', hasInhouseTa: null }]);
  assert.deepEqual(patch, { headcount: null, industry: null, hasInhouseTa: null });
});

test('patchCompany REJECTS a headcount sent as a string (no coercion on patches)', () => {
  bad('patchCompany', [ID, { headcount: '50' }], 'arg1.headcount');
});

test('patchCompany rejects a negative headcount and a bad status', () => {
  bad('patchCompany', [ID, { headcount: -3 }], 'Must be at least 0');
  bad('patchCompany', [ID, { status: 'aproved' }], 'arg1.status');
});

test('patchCompany rejects non-http URLs and normalises a bare host', () => {
  bad('patchCompany', [ID, { website: 'javascript:alert(1)' }], 'http(s) URL');
  bad('patchCompany', [ID, { careersUrl: 'file:///etc/passwd' }], 'http(s) URL');
  bad('patchCompany', [ID, { linkedinUrl: 'not a url' }], 'http(s) URL');
  const [, patch] = ok('patchCompany', [ID, { careersUrl: 'acme.com/jobs' }]);
  assert.deepEqual(patch, { careersUrl: 'https://acme.com/jobs' });
});

test('patchCompany strips unknown keys so they never reach the SQL loop', () => {
  const parsed = companyPatchSchema.parse({ notes: 'ok', name_norm: 'injected', id: 'other' });
  assert.deepEqual(parsed, { notes: 'ok' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContactPatch
// ─────────────────────────────────────────────────────────────────────────────

test('patchContact accepts a full valid patch and lowercases the email', () => {
  const [, patch] = ok('patchContact', [
    ID,
    { fullName: 'Ada Lovelace', persona: 'cto_vpe', email: ' Ada@Acme.COM ', isPrimary: true, status: 'approved' },
  ]);
  assert.deepEqual(patch, {
    fullName: 'Ada Lovelace',
    persona: 'cto_vpe',
    email: 'ada@acme.com',
    isPrimary: true,
    status: 'approved',
  });
});

test('patchContact rejects a malformed email but allows null to clear it', () => {
  bad('patchContact', [ID, { email: 'ada@@acme' }], 'valid email address');
  bad('patchContact', [ID, { email: 'ada acme.com' }], 'valid email address');
  const [, patch] = ok('patchContact', [ID, { email: null }]);
  assert.deepEqual(patch, { email: null });
});

test('patchContact rejects a persona outside the real union', () => {
  bad('patchContact', [ID, { persona: 'chief_vibes_officer' }], 'arg1.persona');
  assert.deepEqual(contactPatchSchema.parse({ persona: null }), { persona: null });
});

test('patchContact rejects a contact status that is not in the CHECK list', () => {
  // 'suppressed' is a *company* status; contact.status has no such value.
  bad('patchContact', [ID, { status: 'suppressed' }], 'arg1.status');
});

test('addContact rejects a blank fullName', () => {
  bad('addContact', [ID, { fullName: '   ' }], 'A contact needs a name');
});

// ─────────────────────────────────────────────────────────────────────────────
// SettingsPatch
// ─────────────────────────────────────────────────────────────────────────────

test('patchSettings accepts a complete, in-bounds patch', () => {
  const [patch] = ok('patchSettings', [
    {
      icp: { minHeadcount: 5, maxHeadcount: 900, staleDays: 45, requireBayArea: true, excludedKeywords: ['agency'] },
      sending: { perHour: 20, perDay: 400, windowStart: '09:00', windowEnd: '17:30', jitterPct: 40 },
      crawl: { concurrency: 10, linkedinPerDay: 25, linkedinEnabled: false },
      spendCapUsd: 100,
    },
  ]);
  assert.equal((patch as { sending: { perDay: number } }).sending.perDay, 400);
});

test("perDay above 500 is rejected — Gmail's hard ceiling", () => {
  const message = bad('patchSettings', [{ sending: { perDay: 501 } }], 'arg0.sending.perDay');
  assert.ok(message.includes('500'), message);
  ok('patchSettings', [{ sending: { perDay: 500 } }]);
});

test('sending bounds: perHour, jitterPct and the send window', () => {
  bad('patchSettings', [{ sending: { perHour: 0 } }], 'perHour must be at least 1');
  bad('patchSettings', [{ sending: { perHour: 201 } }], 'perHour cannot exceed 200');
  // 90 matches the read-side clamp in src/main/settings.ts — the schema and
  // the clamp must agree or accepted values get silently rewritten on read.
  bad('patchSettings', [{ sending: { jitterPct: 91 } }], 'jitterPct cannot exceed 90');
  bad('patchSettings', [{ sending: { jitterPct: -1 } }], 'jitterPct cannot be negative');
  bad('patchSettings', [{ sending: { windowStart: '9am' } }], '24-hour HH:MM');
  bad('patchSettings', [{ sending: { windowEnd: '24:00' } }], '24-hour HH:MM');
  ok('patchSettings', [{ sending: { windowStart: '00:00', windowEnd: '23:59' } }]);
});

test('crawl bounds: concurrency 1-32, linkedinPerDay 0-200', () => {
  bad('patchSettings', [{ crawl: { concurrency: 0 } }], 'concurrency must be at least 1');
  bad('patchSettings', [{ crawl: { concurrency: 33 } }], 'concurrency cannot exceed 32');
  bad('patchSettings', [{ crawl: { linkedinPerDay: 201 } }], 'linkedinPerDay cannot exceed 200');
  bad('patchSettings', [{ crawl: { linkedinPerDay: -1 } }], 'linkedinPerDay cannot be negative');
  ok('patchSettings', [{ crawl: { concurrency: 32, linkedinPerDay: 0, linkedinEnabled: true } }]);
});

test('icp headcounts must be whole numbers and must not invert', () => {
  bad('patchSettings', [{ icp: { minHeadcount: 4.5 } }], 'arg0.icp.minHeadcount');
  bad('patchSettings', [{ icp: { minHeadcount: 900, maxHeadcount: 10 } }], 'minHeadcount cannot exceed maxHeadcount');
  bad('patchSettings', [{ spendCapUsd: -1 }], 'spendCapUsd cannot be negative');
  assert.deepEqual(settingsPatchSchema.parse({ nope: 1 }), {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Suppression — the CHECK constraints in schema.sql
// ─────────────────────────────────────────────────────────────────────────────

test('addSuppression accepts every reason in the schema.sql CHECK list', () => {
  const reasons = [
    'existing_client', 'active_contract', 'past_rejection', 'placed_candidate_employer',
    'competitor', 'no_agency_policy', 'replied_no', 'bounced', 'manual', 'opt_out',
  ];
  for (const reason of reasons) {
    assert.equal(suppressionReasonSchema.safeParse(reason).success, true, reason);
    ok('addSuppression', ['domain', 'acme.com', reason]);
  }
  assert.equal(suppressionReasonSchema.options.length, reasons.length);
});

test('a suppression reason outside the CHECK list is rejected before it hits SQLite', () => {
  bad('addSuppression', ['domain', 'acme.com', 'do_not_like_them'], 'arg2');
  bad('addSuppression', ['domain', 'acme.com', 'unsubscribed'], 'arg2');
  bad('addSuppression', ['domain', 'acme.com', 'OPT_OUT'], 'arg2');
});

test('a suppression kind outside the CHECK list is rejected', () => {
  bad('addSuppression', ['person', 'acme.com', 'manual'], 'arg0');
});

test('addSuppression rejects an empty value and accepts an optional note', () => {
  bad('addSuppression', ['email', '', 'manual'], 'Suppression value cannot be empty');
  assert.deepEqual(ok('addSuppression', ['email', 'a@b.com', 'manual']), ['email', 'a@b.com', 'manual', undefined]);
  ok('addSuppression', ['email', 'a@b.com', 'manual', 'from the CRM']);
});

test('removeSuppression coerces a numeric-string row id but rejects junk', () => {
  assert.deepEqual(ok('removeSuppression', ['42']), [42]);
  assert.deepEqual(ok('removeSuppression', [42]), [42]);
  bad('removeSuppression', [0], 'Row id must be positive');
  bad('removeSuppression', ['abc']);
  bad('removeSuppression', [null]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline, drafts, inbound, exports, keys
// ─────────────────────────────────────────────────────────────────────────────

test('runSource accepts every SourceKey including linkedin_urls', () => {
  for (const key of sourceKeySchema.options) ok('runSource', [key]);
  assert.ok(sourceKeySchema.options.includes('linkedin_urls'));
  bad('runSource', ['ats-sweep'], 'arg0');
  bad('setSourceEnabled', ['yc', 'true'], 'arg1');
  ok('setSourceEnabled', ['yc', false]);
});

test('listDrafts takes an optional draft state from the CHECK list', () => {
  assert.deepEqual(ok('listDrafts', []), [undefined]);
  ok('listDrafts', ['queued']);
  bad('listDrafts', ['pending'], 'arg0');
});

test('generateDraft takes a company id, optional contact id, optional force', () => {
  assert.deepEqual(ok('generateDraft', [ID]), [ID, undefined, undefined]);
  ok('generateDraft', [ID, ID]);
  ok('generateDraft', [ID, ID, true]);
  bad('generateDraft', [ID, ''], 'arg1');
  bad('generateDraft', [ID, ID, 'yes'], 'arg2');
});

test('patchDraft only accepts subject and body', () => {
  assert.deepEqual(ok('patchDraft', [ID, { subject: 'Hi', body: 'Body' }])[1], { subject: 'Hi', body: 'Body' });
  assert.deepEqual(draftPatchSchema.parse({ subject: 'Hi', state: 'sent' }), { subject: 'Hi' });
  bad('patchDraft', [ID, { subject: 'x'.repeat(999) }], 'arg1.subject');
});

test('markInbound only accepts the four real actions', () => {
  for (const action of ['positive', 'negative', 'bounce', 'ignore']) ok('markInbound', [ID, action]);
  bad('markInbound', [ID, 'maybe'], 'arg1');
});

test('listInbound takes an optional boolean', () => {
  assert.deepEqual(ok('listInbound', []), [undefined]);
  assert.deepEqual(ok('listInbound', [false]), [false]);
  bad('listInbound', ['false'], 'arg0');
});

test('exportCsv and testKey are constrained to their real unions', () => {
  ok('exportCsv', ['companies']);
  ok('exportCsv', ['contacts']);
  ok('exportCsv', ['drafts']);
  bad('exportCsv', ['reqs'], 'arg0');
  bad('exportCsv', ['../../etc/passwd'], 'arg0');
  ok('testKey', ['anthropic']);
  bad('testKey', ['openai'], 'arg0');
});

test('resolveConflict constrains the field name and the observation id', () => {
  assert.deepEqual(ok('resolveConflict', [ID, 'headcount', '7']), [ID, 'headcount', 7]);
  bad('resolveConflict', [ID, 'headcount; DROP TABLE company', 1], 'Not a field name');
  bad('resolveConflict', [ID, '', 1], 'arg1');
  bad('resolveConflict', [ID, 'headcount', -1], 'Row id must be positive');
});

test('bulkCompanyStatus validates every id and the target status', () => {
  assert.deepEqual(ok('bulkCompanyStatus', [[ID], 'approved']), [[ID], 'approved']);
  ok('bulkCompanyStatus', [[], 'rejected']);
  bad('bulkCompanyStatus', [[ID, ''], 'approved'], 'arg0[1]');
  bad('bulkCompanyStatus', [[ID], 'archived'], 'arg1');
  bad('bulkCompanyStatus', [ID, 'approved'], 'arg0');
});

test('setSecret constrains the key name but allows an empty value to clear it', () => {
  ok('setSecret', ['verifier_provider', 'reoon']);
  ok('setSecret', ['anthropic', 'sk-ant-xxx']);
  ok('setSecret', ['verifier', '']);
  bad('setSecret', ['../../../etc/passwd', 'x'], 'arg0');
  bad('setSecret', ['anthropic', 'x'.repeat(8193)], 'arg1');
});

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem- and shell-adjacent inputs
// ─────────────────────────────────────────────────────────────────────────────

test('getScreenshot rejects traversal, absolute paths and control characters', () => {
  ok('getScreenshot', ['company/01JQ/shot.png']);
  bad('getScreenshot', ['../../../../etc/passwd'], 'traverse upward');
  bad('getScreenshot', ['company/../../secrets.png'], 'traverse upward');
  bad('getScreenshot', ['/etc/passwd'], 'must be relative');
  bad('getScreenshot', ['C:\\Windows\\win.ini'], 'must be relative');
  bad('getScreenshot', ['shot\u0000.png'], 'control characters');
  assert.equal(relPathSchema.safeParse('a/b/c.png').success, true);
});

test('openExternal only accepts http and https', () => {
  ok('openExternal', ['https://news.ycombinator.com/item?id=1']);
  ok('openExternal', ['http://localhost:5183/']);
  bad('openExternal', ['file:///Users/me/.ssh/id_rsa'], 'http and https');
  bad('openExternal', ['javascript:alert(1)'], 'http and https');
  bad('openExternal', ['https://ok.com/\u0000'], 'control characters');
  assert.equal(externalUrlSchema.safeParse('https://ok.com').success, true);
});

test('importSuppressionsCsv rejects a payload large enough to wedge the main process', () => {
  ok('importSuppressionsCsv', ['domain,reason\nacme.com,manual\n']);
  bad('importSuppressionsCsv', ['x'.repeat(5_000_001)], 'CSV is too large');
  bad('importSuppressionsCsv', [null], 'arg0');
});

// ─────────────────────────────────────────────────────────────────────────────
// Error message quality
// ─────────────────────────────────────────────────────────────────────────────

test('error messages name the channel, the path and the reason — not a zod dump', () => {
  const message = bad('patchSettings', [{ sending: { perDay: 9000 } }]);
  assert.ok(message.startsWith('Invalid arguments for "patchSettings"'), message);
  assert.ok(message.includes('arg0.sending.perDay'), message);
  assert.ok(!message.includes('"code"'), message);
  assert.ok(!message.includes('invalid_type'), message);
  assert.ok(!message.includes('\n'), 'message should be one readable line');
});

test('multiple issues are summarised together and capped', () => {
  const message = bad('patchSettings', [
    { sending: { perDay: 9000, perHour: 0, jitterPct: 500, windowStart: 'x', windowEnd: 'y', signature: 1 } },
  ]);
  assert.ok(message.includes(';'), message);
  assert.ok(message.split(';').length <= 7, message);
});

test('normaliseUrl is deterministic about what it will and will not repair', () => {
  assert.equal(normaliseUrl('acme.com'), 'https://acme.com/');
  assert.equal(normaliseUrl('https://acme.com/jobs'), 'https://acme.com/jobs');
  assert.equal(normaliseUrl('ftp://acme.com'), null);
  assert.equal(normaliseUrl('localhost'), null);
  assert.equal(normaliseUrl('   '), null);
});
