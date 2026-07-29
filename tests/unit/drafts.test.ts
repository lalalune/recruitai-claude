/**
 * Draft generation — the copy that actually reaches a human being.
 *
 * Three things are pinned here, in order of how badly they hurt when broken:
 *
 *  1. Nothing that is missing from the database may surface as a placeholder in
 *     an email. A null location, a null fee, an unknown recruiter situation:
 *     each must remove its sentence, never render as "undefined" or "null".
 *  2. generateDraftFor refuses rather than improvises — no open req, no contact,
 *     a suppressed identity, or an unapproved company all end in DraftNotPossible.
 *  3. The recipient address is unreachable from generation. The model never sees
 *     one, cannot emit one, and the returned draft carries no address field —
 *     the address is read from the contact row at send time and only there.
 *
 * The LLM path runs against a stubbed global fetch. Nothing here touches the
 * network; a test that did would be billing a real account.
 */

// Must come first: patches require('electron') before any app module loads.
import { installElectronStub } from '../e2e/electron-stub.js';

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, all, get, run, ulid, type Db } from '../../src/main/db/index.js';
import { setDataDir, patchSettings, writeSecret, SECRET_ANTHROPIC } from '../../src/main/settings.js';
import { upsertCompany } from '../../src/main/pipeline/ingest.js';
import {
  SpendCapExceeded,
  commitApiCall,
  releaseApiCall,
  reserveApiCall,
  totalSpentMicros,
} from '../../src/main/pipeline/tasks.js';
import {
  DraftNotPossible,
  bandFor,
  generateDraftFor,
  renderBody,
  renderSubject,
  rewriteBodyProse,
  type DraftFacts,
} from '../../src/main/pipeline/drafts.js';

installElectronStub();

let tmpRoot = '';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-drafts-unit-'));
  setDataDir(tmpRoot);
  initDb(path.join(tmpRoot, 'drafts-unit.db'));
  await patchSettings({
    sending: { signature: 'Shaw', postalAddress: '548 Market St, San Francisco, CA', includeOptOutLine: true },
  });
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
// Banding
// ─────────────────────────────────────────────────────────────────────────────

describe('drafts bandFor', () => {
  test('drafts bandFor puts every boundary on the documented side', () => {
    assert.equal(bandFor(0), 'under_20');
    assert.equal(bandFor(19), 'under_20');
    assert.equal(bandFor(20), '20_75');
    assert.equal(bandFor(75), '20_75');
    assert.equal(bandFor(76), '75_300');
    assert.equal(bandFor(300), '75_300');
    assert.equal(bandFor(301), 'over_300');
    assert.equal(bandFor(50_000), 'over_300');
  });

  test('drafts bandFor treats an unknown headcount as the middle band, not the largest', () => {
    // The copy differs materially per band: over_300 opens with "you have a
    // preferred supplier list". Defaulting an unknown headcount there would put
    // that sentence in front of five-person startups.
    assert.equal(bandFor(null), '20_75');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering with missing facts
// ─────────────────────────────────────────────────────────────────────────────

function facts(over: Partial<DraftFacts> = {}): DraftFacts {
  return {
    companyName: 'Northwind Robotics',
    contactFirstName: 'Ada',
    contactTitle: null,
    band: '20_75',
    headcount: 40,
    reqTitle: 'Staff Engineer',
    reqDaysOpen: 52,
    reqLocation: 'San Francisco',
    reqReposted: 0,
    openReqCount: 3,
    openEngCount: 2,
    staleReqCount: 1,
    hasInhouseRecruiter: false,
    estimatedFeeUsd: 62_000,
    fundingStage: null,
    ycBatch: null,
    ...over,
  };
}

/** Placeholder shapes that must never survive into a message to a human. */
const LEAKS = [/\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\{[A-Za-z]+\}/, /\[object Object\]/];

function assertNoLeaks(text: string, label: string): void {
  for (const re of LEAKS) {
    assert.ok(!re.test(text), `${label} leaked ${re} into copy:\n${text}`);
  }
}

describe('drafts renderSubject / renderBody', () => {
  test('drafts renderers survive every null-able fact being null, in every band', () => {
    const empty: Partial<DraftFacts> = {
      contactTitle: null,
      headcount: null,
      reqLocation: null,
      hasInhouseRecruiter: null,
      estimatedFeeUsd: null,
      fundingStage: null,
      ycBatch: null,
      reqReposted: 0,
      openReqCount: 1,
      openEngCount: 0,
      staleReqCount: 0,
    };

    for (const band of ['under_20', '20_75', '75_300', 'over_300'] as const) {
      const f = facts({ ...empty, band });
      const subject = renderSubject(f);
      const body = renderBody(f);

      assertNoLeaks(subject, `${band} subject`);
      assertNoLeaks(body, `${band} body`);
      assert.ok(subject.trim().length > 0, `${band} subject is empty`);
      assert.ok(body.startsWith('Hi Ada,'), `${band} body does not open with the greeting`);
      // A null location must remove the phrase, not render an empty one.
      assert.ok(!/\bin\s*\.|\bin\s{2}/.test(body), `${band} body has a dangling location phrase:\n${body}`);
    }
  });

  test('drafts renderBody drops the fee sentence rather than guessing when no fee is known', () => {
    const withFee = renderBody(facts({ band: '75_300', estimatedFeeUsd: 90_000 }));
    assert.ok(withFee.includes('roughly $90k'), `expected a banded fee, got:\n${withFee}`);

    const without = renderBody(facts({ band: '75_300', estimatedFeeUsd: null }));
    assert.ok(without.includes('standard contingency terms'));
    assert.ok(!without.includes('roughly'), 'a missing fee must not degrade into "roughly "');
    assertNoLeaks(without, 'feeless 75_300 body');
  });

  test('drafts renderBody states the recruiter situation only when it is actually known', () => {
    const unknown = renderBody(facts({ band: '20_75', hasInhouseRecruiter: null }));
    assert.ok(!unknown.includes('from the outside it looks like'), 'unknown TA state must stay unsaid');

    const none = renderBody(facts({ band: '20_75', hasInhouseRecruiter: false }));
    assert.ok(none.includes("you don't have an in-house recruiter"));

    const some = renderBody(facts({ band: '20_75', hasInhouseRecruiter: true }));
    assert.ok(some.includes('carrying it alongside everything else'));
  });

  test('drafts renderBody pluralises a repost count instead of writing "1 times"', () => {
    assert.ok(renderBody(facts({ reqReposted: 1 })).includes('reposted once'));
    assert.ok(renderBody(facts({ reqReposted: 3 })).includes('reposted 3 times'));
    assert.ok(!renderBody(facts({ reqReposted: 0 })).includes('reposted'));
  });

  test('drafts renderSubject switches on the 45-day staleness threshold', () => {
    assert.equal(
      renderSubject(facts({ band: '20_75', reqDaysOpen: 45 })),
      'Your Staff Engineer req — open 45 days',
    );
    assert.equal(
      renderSubject(facts({ band: '20_75', reqDaysOpen: 44 })),
      'Staff Engineer — a few people worth meeting',
    );
  });

  test('drafts renderSubject falls back to total reqs when none are engineering', () => {
    assert.equal(
      renderSubject(facts({ band: '75_300', openEngCount: 4 })),
      '4 open eng roles at Northwind Robotics',
    );
    assert.equal(
      renderSubject(facts({ band: '75_300', openEngCount: 0, openReqCount: 9 })),
      '9 open roles at Northwind Robotics',
    );
  });

  test('drafts renderBody appends the milestone line only when a milestone exists', () => {
    assert.ok(!renderBody(facts()).includes('Congratulations'));
    const both = renderBody(facts({ fundingStage: 'Series B', ycBatch: 'W24' }));
    assert.ok(both.includes('Congratulations on the Series B · YC W24 milestone'));
    const ycOnly = renderBody(facts({ fundingStage: null, ycBatch: 'S23' }));
    assert.ok(ycOnly.includes('Congratulations on the YC S23 milestone'), ycOnly);
  });

  test('drafts renderers never emit anything address-, URL-, or phone-shaped', () => {
    // The model path is checked for this explicitly; the deterministic path has
    // to hold it by construction, and this is the assertion that keeps it true
    // if someone later adds "reply to me at ..." to a template.
    for (const band of ['under_20', '20_75', '75_300', 'over_300'] as const) {
      const text = `${renderSubject(facts({ band }))}\n${renderBody(facts({ band }))}`;
      assert.ok(!text.includes('@'), `${band} copy contains an @`);
      assert.ok(!/https?:\/\/|www\./i.test(text), `${band} copy contains a URL`);
      assert.ok(!/\+?\d[\d\s().-]{8,}\d/.test(text), `${band} copy contains a phone-shaped run`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────────────────────

interface SeedOpts {
  headcount?: number;
  approved?: boolean;
  withReq?: boolean;
  withContact?: boolean;
  email?: string | null;
  contactStatus?: string;
}

let seq = 0;

function seed(db: Db, tag: string, opts: SeedOpts = {}): { companyId: string; contactId: string | null; domain: string } {
  const domain = `${tag}-${++seq}.drafts.test`;
  const companyId = upsertCompany(db, { name: `Draft ${tag} ${seq}`, domain });
  run(
    db,
    `UPDATE company SET status = ?, headcount = ?, open_req_count = 1, updated_at = ? WHERE id = ?`,
    opts.approved === false ? 'scored' : 'approved',
    opts.headcount ?? 40,
    Date.now(),
    companyId,
  );

  if (opts.withReq !== false) {
    run(
      db,
      `INSERT INTO req (company_id, external_id, source, title, location, url, first_seen_at, last_seen_at, published_at)
       VALUES (?, ?, 'greenhouse', 'Staff Engineer', 'San Francisco', 'https://example.test/job', ?, ?, ?)`,
      companyId,
      `req-${domain}`,
      Date.now() - 60 * 86_400_000,
      Date.now(),
      Date.now() - 60 * 86_400_000,
    );
  }

  let contactId: string | null = null;
  if (opts.withContact !== false) {
    contactId = ulid();
    run(
      db,
      `INSERT INTO contact (id, company_id, full_name, first_name, email, status)
       VALUES (?, ?, 'Ada Lovelace', 'Ada', ?, ?)`,
      contactId,
      companyId,
      opts.email === null ? null : (opts.email ?? `ada@${domain}`),
      opts.contactStatus ?? 'approved',
    );
  }

  return { companyId, contactId, domain };
}

describe('drafts generateDraftFor refuses rather than improvises', () => {
  test('drafts generation refuses when the company has no open requisition', async () => {
    const db = getDb();
    const { companyId } = seed(db, 'noreq', { withReq: false });
    await assert.rejects(
      () => generateDraftFor(db, companyId, undefined, { useLlm: false }),
      (err: unknown) => err instanceof DraftNotPossible && /No open requisition/.test((err as Error).message),
    );
    assert.equal(all(db, 'SELECT id FROM draft WHERE company_id = ?', companyId).length, 0);
  });

  test('drafts generation refuses when a req closes under an otherwise eligible company', async () => {
    const db = getDb();
    const { companyId } = seed(db, 'closed');
    run(db, 'UPDATE req SET closed_at = ? WHERE company_id = ?', Date.now(), companyId);
    await assert.rejects(
      () => generateDraftFor(db, companyId, undefined, { useLlm: false }),
      /No open requisition/,
    );
  });

  test('drafts generation refuses when there is no contact, or the contact has no address', async () => {
    const db = getDb();
    const none = seed(db, 'nocontact', { withContact: false });
    await assert.rejects(
      () => generateDraftFor(db, none.companyId, undefined, { useLlm: false }),
      (err: unknown) => err instanceof DraftNotPossible && /No eligible contact/.test((err as Error).message),
    );

    const addressless = seed(db, 'noaddr', { email: null });
    await assert.rejects(
      () => generateDraftFor(db, addressless.companyId, undefined, { useLlm: false }),
      /No eligible contact/,
      'a contact row with no address is not a contact we can write to',
    );
  });

  test('drafts generation refuses a rejected contact and an unapproved company', async () => {
    const db = getDb();
    const rejected = seed(db, 'rejected', { contactStatus: 'rejected' });
    await assert.rejects(
      () => generateDraftFor(db, rejected.companyId, undefined, { useLlm: false }),
      /No eligible contact/,
    );

    const unapproved = seed(db, 'unapproved', { approved: false });
    await assert.rejects(
      () => generateDraftFor(db, unapproved.companyId, undefined, { useLlm: false }),
      /No eligible contact/,
      'review is not optional: an unapproved company cannot produce a draft',
    );
  });

  test('drafts generation refuses a suppressed address, its domain, and the company itself', async () => {
    const db = getDb();

    const byEmail = seed(db, 'supemail');
    run(
      db,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('email', ?, 'manual', ?)`,
      `ada@${byEmail.domain}`,
      Date.now(),
    );
    await assert.rejects(
      () => generateDraftFor(db, byEmail.companyId, undefined, { useLlm: false }),
      /No eligible contact/,
      'a suppressed address must not be writable to',
    );

    const byDomain = seed(db, 'supdomain');
    run(
      db,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('domain', ?, 'existing_client', ?)`,
      byDomain.domain,
      Date.now(),
    );
    await assert.rejects(
      () => generateDraftFor(db, byDomain.companyId, undefined, { useLlm: false }),
      /No eligible contact/,
      'a suppressed domain must not be writable to',
    );

    const byCompany = seed(db, 'supcompany');
    run(
      db,
      `INSERT INTO suppression (kind, value, reason, created_at) VALUES ('company', ?, 'competitor', ?)`,
      byCompany.companyId.toLowerCase(),
      Date.now(),
    );
    await assert.rejects(
      () => generateDraftFor(db, byCompany.companyId, undefined, { useLlm: false }),
      /No eligible contact/,
      'a suppressed company must not be writable to',
    );

    // The refusals above are the point, but so is this: not one of them wrote a
    // row. A suppressed identity leaves no draft behind to be queued later.
    for (const c of [byEmail, byDomain, byCompany]) {
      assert.equal(all(db, 'SELECT id FROM draft WHERE company_id = ?', c.companyId).length, 0);
    }
  });

  test('drafts generation picks the requested contact, and refuses one from another company', async () => {
    const db = getDb();
    const a = seed(db, 'picka');
    const b = seed(db, 'pickb');
    const draft = await generateDraftFor(db, a.companyId, a.contactId!, { useLlm: false });
    assert.equal(draft.contactId, a.contactId);

    await assert.rejects(
      () => generateDraftFor(db, a.companyId, b.contactId!, { useLlm: false }),
      /No eligible contact/,
      "a contact id from a different company must not resolve against this company's row",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The address barrier
// ─────────────────────────────────────────────────────────────────────────────

describe('drafts never carry a recipient address', () => {
  test('drafts the draft table has no address column and the generated body has no @', async () => {
    const db = getDb();
    const { companyId, domain } = seed(db, 'noaddrcol');
    const draft = await generateDraftFor(db, companyId, undefined, { useLlm: false });

    const columns = all<{ name: string }>(db, `SELECT name FROM pragma_table_info('draft')`).map((c) => c.name);
    for (const name of columns) {
      assert.ok(
        !/mail|address|recipient|^to$|^to_/i.test(name),
        `draft.${name} looks like a place a recipient address could be stored`,
      );
    }

    const stored = get<{ subject: string; body: string }>(db, 'SELECT subject, body FROM draft WHERE id = ?', draft.id)!;
    assert.ok(!stored.body.includes(`@${domain}`), 'the contact address reached the stored body');
    assert.ok(!stored.subject.includes('@'));
    assert.ok(!JSON.stringify(draft).includes(`@${domain}`), 'the returned draft object carries the address');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The LLM rewrite path — stubbed transport, never the network
// ─────────────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: string;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

/** Replace the global transport httpRequest sits on. Nothing leaves the box. */
function stubAnthropic(reply: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function anthropicReply(text: string, usage = { input_tokens: 900, output_tokens: 400 }): unknown {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
}

/** Long enough to clear the 80-character floor the rewrite guard imposes. */
const GOOD_PROSE =
  'Hi Ada,\n\nYour Staff Engineer req has been open a while and the search looks like it is ' +
  'sitting on somebody who already has a full job. I would send three profiles first.';

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('drafts rewriteBodyProse fails closed', () => {
  before(async () => {
    await writeSecret(SECRET_ANTHROPIC, 'sk-ant-test-key');
    await patchSettings({ spendCapUsd: 100 });
  });

  test('drafts a clean rewrite is accepted and the ledger records the actual cost', async () => {
    const db = getDb();
    stubAnthropic(anthropicReply(GOOD_PROSE));
    const key = `unit:clean:${ulid()}`;
    const res = await rewriteBodyProse(db, facts(), 'deterministic body', key);

    assert.equal(res.body, GOOD_PROSE);
    assert.equal(calls.length, 1);
    const row = get<{ state: string; actual_cost_micros: number }>(
      db,
      'SELECT state, actual_cost_micros FROM api_call WHERE idempotency_key = ?',
      key,
    )!;
    assert.equal(row.state, 'succeeded');
    // $5/MTok in, $25/MTok out: 900*5 + 400*25.
    assert.equal(row.actual_cost_micros, 900 * 5 + 400 * 25);
  });

  test('drafts a rewrite containing an address, a URL, or a phone number is discarded whole', async () => {
    const db = getDb();
    const poisoned = [
      ['an email address', `${GOOD_PROSE}\n\nReply to shaw@recruit.example any time.`],
      ['a bare https URL', `${GOOD_PROSE}\n\nBook here: https://calendly.example/shaw`],
      ['a www URL', `${GOOD_PROSE}\n\nMore at www.recruit.example`],
      ['a calendly mention', `${GOOD_PROSE}\n\nGrab a calendly slot whenever.`],
      ['a phone number', `${GOOD_PROSE}\n\nOr call +1 (415) 555-0199.`],
    ] as const;

    for (const [label, text] of poisoned) {
      stubAnthropic(anthropicReply(text));
      const res = await rewriteBodyProse(db, facts(), 'deterministic body', `unit:poison:${ulid()}`);
      assert.equal(res.body, null, `${label} survived the guard`);
      assert.match(res.note, /contact-shaped/, `${label} was rejected for the wrong reason: ${res.note}`);
    }
  });

  test('drafts an out-of-range rewrite, an empty one, and a refusal all fall back silently', async () => {
    const db = getDb();

    stubAnthropic(anthropicReply('Hi Ada, too short.'));
    assert.equal((await rewriteBodyProse(db, facts(), 'body', `unit:short:${ulid()}`)).body, null);

    stubAnthropic(anthropicReply('x'.repeat(4001)));
    assert.equal((await rewriteBodyProse(db, facts(), 'body', `unit:long:${ulid()}`)).body, null);

    stubAnthropic(anthropicReply(''));
    assert.equal((await rewriteBodyProse(db, facts(), 'body', `unit:empty:${ulid()}`)).body, null);

    stubAnthropic({ content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } });
    const refused = await rewriteBodyProse(db, facts(), 'body', `unit:refusal:${ulid()}`);
    assert.equal(refused.body, null);
    assert.match(refused.note, /declined/);
  });

  test('drafts a transport failure releases the reservation so a later pass can retry', async () => {
    const db = getDb();
    stubAnthropic('service unavailable', 503);
    const key = `unit:503:${ulid()}`;
    const res = await rewriteBodyProse(db, facts(), 'body', key);

    assert.equal(res.body, null);
    assert.equal(
      get(db, 'SELECT id FROM api_call WHERE idempotency_key = ?', key),
      undefined,
      'a refused call must not leave a reservation wedging the key forever',
    );
  });

  test('drafts unparseable JSON is committed as failed, not retried into a second charge', async () => {
    const db = getDb();
    stubAnthropic('<html>gateway</html>');
    const key = `unit:garbage:${ulid()}`;
    assert.equal((await rewriteBodyProse(db, facts(), 'body', key)).body, null);
    const row = get<{ state: string }>(db, 'SELECT state FROM api_call WHERE idempotency_key = ?', key)!;
    assert.equal(row.state, 'failed');

    // The same key a second time is a ledger hit: no second HTTP call.
    stubAnthropic(anthropicReply(GOOD_PROSE));
    const again = await rewriteBodyProse(db, facts(), 'body', key);
    assert.equal(again.body, null);
    assert.equal(calls.length, 0, 'a reserved key must never be paid for twice');
  });

  test('drafts the model is never handed a contact address, and cannot introduce one', async () => {
    const db = getDb();
    const { companyId, domain } = seed(db, 'llmfacts');
    const address = `ada@${domain}`;

    // The model tries to helpfully re-add a sign-off with an address in it.
    stubAnthropic(anthropicReply(`${GOOD_PROSE}\n\n— Shaw, ${address}`));
    const draft = await generateDraftFor(db, companyId, undefined, { useLlm: true });

    assert.equal(calls.length, 1, 'expected exactly one model call');
    const sent = calls[0]!.body;
    assert.ok(!sent.includes(address), 'the contact address was sent to the model');
    assert.ok(!sent.includes('@'), `something address-shaped reached the model:\n${sent}`);

    // Rejected whole: the deterministic body is what got stored.
    assert.ok(!draft.body.includes(address), 'a model-authored address reached the draft');
    assert.ok(!draft.generatedBy.includes('claude'), `the rewrite was accepted: ${draft.generatedBy}`);
    const stored = get<{ body: string }>(db, 'SELECT body FROM draft WHERE id = ?', draft.id)!;
    assert.ok(!stored.body.includes('@'), 'an address reached the stored draft body');
  });

  test('drafts with no key configured the deterministic body is used and nothing is charged', async () => {
    const db = getDb();
    await writeSecret(SECRET_ANTHROPIC, '');
    stubAnthropic(anthropicReply(GOOD_PROSE));
    const { companyId } = seed(db, 'nokey');
    const draft = await generateDraftFor(db, companyId, undefined, { useLlm: true });

    assert.equal(calls.length, 0, 'a call went out with no key configured');
    assert.equal(draft.generatedBy, 'template:20_75');
    await writeSecret(SECRET_ANTHROPIC, 'sk-ant-test-key');
  });

  test('drafts the ledger the cap reads is the ledger the rewrite writes to', async () => {
    // These are two different functions in two different files, and if they
    // ever stop agreeing the cap silently stops capping. Pin them to each
    // other rather than to a hardcoded number.
    const db = getDb();
    const before = totalSpentMicros(db);
    stubAnthropic(anthropicReply(GOOD_PROSE, { input_tokens: 1000, output_tokens: 200 }));
    await rewriteBodyProse(db, facts(), 'body', `unit:ledger:${ulid()}`);
    assert.equal(totalSpentMicros(db) - before, 1000 * 5 + 200 * 25);

    // A released reservation leaves no spend behind; a committed failure does
    // not either. Only a real completed call moves the number.
    const released = reserveApiCall(db, {
      provider: 'anthropic',
      endpoint: '/v1/messages',
      idempotencyKey: `unit:release:${ulid()}`,
      estCostMicros: 15_000,
    })!;
    const withReservation = totalSpentMicros(db);
    assert.ok(withReservation > before, 'a live reservation must count against the cap while in flight');
    releaseApiCall(db, released, 'never issued');
    assert.equal(totalSpentMicros(db), withReservation - 15_000);

    const failed = reserveApiCall(db, {
      provider: 'anthropic',
      endpoint: '/v1/messages',
      idempotencyKey: `unit:failed:${ulid()}`,
      estCostMicros: 15_000,
    })!;
    const nowSpent = totalSpentMicros(db);
    commitApiCall(db, failed, { ok: false, httpStatus: 500, actualCostMicros: 0 });
    assert.equal(totalSpentMicros(db), nowSpent - 15_000, 'a failed call must not be billed');
  });

  test('drafts reserving past the cap throws SpendCapExceeded before any request exists', () => {
    const db = getDb();
    assert.throws(
      () =>
        reserveApiCall(db, {
          provider: 'anthropic',
          endpoint: '/v1/messages',
          idempotencyKey: `unit:capthrow:${ulid()}`,
          estCostMicros: 15_000,
          capUsdMicros: 0,
        }),
      SpendCapExceeded,
    );
  });

  test('drafts the spend cap stops generation before the request is made', async () => {
    const db = getDb();
    await patchSettings({ spendCapUsd: 0 });
    stubAnthropic(anthropicReply(GOOD_PROSE));
    const res = await rewriteBodyProse(db, facts(), 'body', `unit:cap:${ulid()}`);
    assert.equal(res.body, null);
    assert.match(res.note, /Spend cap reached/);
    assert.equal(calls.length, 0, 'the cap must be checked before the money is spent, not after');
    await patchSettings({ spendCapUsd: 100 });
  });
});
