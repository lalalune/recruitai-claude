/**
 * Pipeline integration tests — real database, real ingest, real scoring.
 *
 * These cover the four places where the pipeline silently produces plausible
 * garbage rather than failing: derived company columns drifting from the reqs
 * that produced them, requisition diffing losing the "reposted" signal (the
 * strongest thing there is to put in a cold email), entity resolution merging
 * two companies that share a hosting provider, and provenance losing track of
 * which source said what.
 *
 * No network, with one explicitly skipped exception at the bottom.
 */

// Must come first: patches require('electron') before any app module is evaluated.
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, all, get, run, tx, type Db } from '../../src/main/db/index.js';
import {
  etldPlusOne,
  normName,
  observeCompany,
  storeRaw,
  upsertCompany,
  upsertReqs,
  writeObservation,
  resolveEntityField,
} from '../../src/main/pipeline/ingest.js';
import {
  classifyFunctionFamily,
  classifyNoAgency,
  classifySeniority,
  isSuppressed,
  recomputeCompany,
  scoreAll,
} from '../../src/main/pipeline/scoring.js';
import { getIcp } from '../../src/main/settings.js';
import { fetchGreenhouse } from '../../src/main/sources/ats.js';
import type { RunCtx, SourceOutcome } from '../../src/main/pipeline/run.js';
import type { DiscoveredJob } from '../../src/shared/types.js';

installElectronStub();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
/** Fixed clock so day arithmetic in the assertions is exact, not approximate. */
const NOW = new Date('2026-07-01T12:00:00.000Z');

let tmpRoot = '';
let seq = 0;

function newDb(name: string): Db {
  closeDb();
  return initDb(path.join(tmpRoot, `${name}-${seq++}.db`));
}

interface CompanySeed {
  id: string;
  name: string;
  domain?: string | null;
  headcount?: number | null;
  inBayArea?: 0 | 1;
  ycBatch?: string | null;
  atsPlatform?: string | null;
  recruiterCount?: number | null;
}

function seedCompany(db: Db, seed: CompanySeed): string {
  run(
    db,
    `INSERT INTO company (id, domain, name, name_norm, headcount, in_bay_area, yc_batch, ats_platform,
                          recruiter_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seed.id,
    seed.domain ?? null,
    seed.name,
    normName(seed.name),
    seed.headcount ?? null,
    seed.inBayArea ?? 1,
    seed.ycBatch ?? null,
    seed.atsPlatform ?? null,
    seed.recruiterCount ?? null,
    NOW.getTime(),
    NOW.getTime(),
  );
  return seed.id;
}

interface ReqSeed {
  externalId: string;
  title: string;
  department?: string | null;
  publishedDaysAgo: number;
  closedDaysAgo?: number | null;
  compMin?: number | null;
  compMax?: number | null;
  noAgency?: 0 | 1 | null;
}

function seedReq(db: Db, companyId: string, seed: ReqSeed): number {
  const row = get<{ id: number }>(
    db,
    `INSERT INTO req (company_id, external_id, source, title, department, location, comp_min, comp_max,
                      description, url, first_seen_at, last_seen_at, published_at, closed_at, no_agency_disclaimer)
     VALUES (?, ?, 'greenhouse', ?, ?, 'San Francisco, CA', ?, ?, NULL, ?, ?, ?, ?, ?, ?) RETURNING id`,
    companyId,
    seed.externalId,
    seed.title,
    seed.department ?? null,
    seed.compMin ?? null,
    seed.compMax ?? null,
    `https://example.test/jobs/${seed.externalId}`,
    NOW.getTime() - seed.publishedDaysAgo * DAY,
    NOW.getTime(),
    NOW.getTime() - seed.publishedDaysAgo * DAY,
    seed.closedDaysAgo == null ? null : NOW.getTime() - seed.closedDaysAgo * DAY,
    seed.noAgency ?? null,
  );
  return row!.id;
}

interface CompanyDerived {
  open_req_count: number;
  open_req_eng_count: number;
  stale_req_count: number;
  max_days_open: number | null;
  estimated_fee_usd: number | null;
  no_agency_policy: number;
  quality_score: number | null;
  score_raw: number | null;
  score_headline: string | null;
  disqualified: string | null;
  status: string;
}

function derivedOf(db: Db, id: string): CompanyDerived {
  return get<CompanyDerived>(
    db,
    `SELECT open_req_count, open_req_eng_count, stale_req_count, max_days_open, estimated_fee_usd,
            no_agency_policy, quality_score, score_raw, score_headline, disqualified, status
       FROM company WHERE id = ?`,
    id,
  )!;
}

interface CapturedCtx extends RunCtx {
  logs: { level: string; message: string }[];
  progressCalls: [number, number][];
}

function makeCtx(key: RunCtx['key'] = 'scoring'): CapturedCtx {
  const logs: { level: string; message: string }[] = [];
  const progressCalls: [number, number][] = [];
  return {
    key,
    logs,
    progressCalls,
    log: (level, message) => logs.push({ level, message }),
    progress: (done, total) => progressCalls.push([done, total]),
    cancelled: () => false,
  };
}

function job(externalId: string, over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    externalId,
    title: `Backend Engineer ${externalId}`,
    url: `https://acme.dev/jobs/${externalId}`,
    ...over,
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-pipeline-test-'));
});

after(() => {
  closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('scoring: derived company columns', () => {
  test('recomputeCompany derives every column from the req rows', () => {
    const db = newDb('derive');
    const id = seedCompany(db, {
      id: 'C1',
      name: 'Acme Robotics',
      domain: 'acme.dev',
      headcount: 40,
      ycBatch: 'W24',
      atsPlatform: 'greenhouse',
    });

    seedReq(db, id, { externalId: 'r1', title: 'Senior Backend Engineer', publishedDaysAgo: 60, compMin: 200_000, compMax: 240_000 });
    seedReq(db, id, { externalId: 'r2', title: 'Product Designer', publishedDaysAgo: 10, compMin: 150_000, compMax: 170_000 });
    seedReq(db, id, { externalId: 'r3', title: 'Account Executive', publishedDaysAgo: 3 });
    seedReq(db, id, { externalId: 'r4', title: 'Data Scientist', publishedDaysAgo: 200, closedDaysAgo: 5, compMin: 300_000, compMax: 300_000 });

    recomputeCompany(db, id, getIcp(), NOW);
    const d = derivedOf(db, id);

    assert.equal(d.open_req_count, 3, 'the closed req must not count as open');
    assert.equal(d.open_req_eng_count, 1);
    assert.equal(d.stale_req_count, 1, 'only the 60-day-old req is past the 45-day ICP threshold');
    assert.equal(d.max_days_open, 60);
    // Top three fees at the 30% contingency rate: 220k*.3 + 160k*.3, the third
    // open req publishes no comp. The closed req is excluded entirely.
    assert.equal(d.estimated_fee_usd, 66_000 + 48_000);
    assert.equal(d.no_agency_policy, 0);
    assert.equal(d.disqualified, null);
    assert.equal(d.status, 'scored');

    // 11 hiring + 25 fee + 17 fit + 4 quality + 0 contactability
    assert.equal(d.score_raw, 57);
    assert.equal(d.quality_score, 7);

    assert.equal(d.score_headline, '3 open roles (1 eng) · 1 open >45d (oldest 60d) · ~$114k potential fee');
  });

  test('recomputing is idempotent and converges after the reqs change', () => {
    const db = newDb('converge');
    const id = seedCompany(db, { id: 'C1', name: 'Acme Robotics', domain: 'acme.dev', headcount: 40 });
    seedReq(db, id, { externalId: 'r1', title: 'Backend Engineer', publishedDaysAgo: 50, compMin: 180_000, compMax: 180_000 });

    recomputeCompany(db, id, getIcp(), NOW);
    const first = derivedOf(db, id);
    recomputeCompany(db, id, getIcp(), NOW);
    assert.deepEqual(derivedOf(db, id), first, 'a second pass must not change anything');

    seedReq(db, id, { externalId: 'r2', title: 'Frontend Engineer', publishedDaysAgo: 2 });
    recomputeCompany(db, id, getIcp(), NOW);
    const second = derivedOf(db, id);
    assert.equal(second.open_req_count, 2);
    assert.equal(second.open_req_eng_count, 2);
    assert.equal(second.max_days_open, 50);
  });

  test('a no-agency disclaimer disqualifies the company and clears its score', () => {
    const db = newDb('noagency');
    const id = seedCompany(db, { id: 'C1', name: 'Polite Corp', domain: 'polite.test', headcount: 50 });
    seedReq(db, id, { externalId: 'r1', title: 'Backend Engineer', publishedDaysAgo: 30, compMin: 200_000, compMax: 200_000 });
    seedReq(db, id, { externalId: 'r2', title: 'Frontend Engineer', publishedDaysAgo: 10, noAgency: 1 });

    recomputeCompany(db, id, getIcp(), NOW);
    const d = derivedOf(db, id);

    assert.equal(d.no_agency_policy, 1);
    assert.equal(d.disqualified, 'Job posting states no agency submissions');
    assert.equal(d.quality_score, null, 'a disqualified company must not carry a score to sort by');
    assert.equal(d.score_raw, null);
    // The derived counts are still computed — the operator needs to see why.
    assert.equal(d.open_req_count, 2);
  });

  test('a company with no open reqs is disqualified rather than scored zero', () => {
    const db = newDb('noreqs');
    const id = seedCompany(db, { id: 'C1', name: 'Quiet Co', domain: 'quiet.test', headcount: 40 });
    seedReq(db, id, { externalId: 'r1', title: 'Backend Engineer', publishedDaysAgo: 90, closedDaysAgo: 1 });

    recomputeCompany(db, id, getIcp(), NOW);
    const d = derivedOf(db, id);
    assert.equal(d.open_req_count, 0);
    assert.equal(d.max_days_open, null);
    assert.equal(d.disqualified, 'No open roles');
  });

  test('suppression outranks everything the scorer would otherwise say', () => {
    const db = newDb('suppressed');
    const id = seedCompany(db, { id: 'C1', name: 'Existing Client', domain: 'client.test', headcount: 40 });
    seedReq(db, id, { externalId: 'r1', title: 'Backend Engineer', publishedDaysAgo: 60, compMin: 250_000, compMax: 250_000 });

    assert.equal(isSuppressed(db, id, 'client.test'), false);
    // Stored uppercase on purpose: the lookup is case-insensitive by design.
    run(db, `INSERT INTO suppression (kind, value, reason) VALUES ('domain', 'CLIENT.TEST', 'existing_client')`);
    assert.equal(isSuppressed(db, id, 'client.test'), true);
    assert.equal(isSuppressed(db, 'C_OTHER', 'somewhere-else.test'), false);

    recomputeCompany(db, id, getIcp(), NOW);
    const d = derivedOf(db, id);
    assert.equal(d.status, 'suppressed');
    assert.equal(d.disqualified, 'Suppressed');
    assert.equal(d.quality_score, null);
  });

  test('recomputeCompany scores contacts and elects exactly one primary', () => {
    const db = newDb('primary');
    const id = seedCompany(db, { id: 'C1', name: 'Acme Robotics', domain: 'acme.dev', headcount: 40 });
    seedReq(db, id, { externalId: 'r1', title: 'Backend Engineer', publishedDaysAgo: 20, compMin: 200_000, compMax: 200_000 });

    const insertContact = (cid: string, name: string, persona: string | null, email: string | null, verdict: string) =>
      run(
        db,
        `INSERT INTO contact (id, company_id, full_name, persona, email, email_verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        cid,
        id,
        name,
        persona,
        email,
        verdict,
        NOW.getTime(),
        NOW.getTime(),
      );

    insertContact('CT_FOUNDER', 'Ada Founder', 'founder_ceo', 'ada@acme.dev', 'valid');
    insertContact('CT_OTHER', 'Bob Anyone', 'other', 'bob@acme.dev', 'unverified');
    insertContact('CT_NOEMAIL', 'Cleo Unreachable', 'cto_vpe', null, 'unverified');

    recomputeCompany(db, id, getIcp(), NOW);

    // founder at 40 people = base 100, verdict 'valid' = x1.
    assert.equal(get<{ s: number }>(db, 'SELECT contact_score AS s FROM contact WHERE id = ?', 'CT_FOUNDER')?.s, 100);
    // 'other' persona = base 25, 'unverified' = x0.25 → 6.
    assert.equal(get<{ s: number }>(db, 'SELECT contact_score AS s FROM contact WHERE id = ?', 'CT_OTHER')?.s, 6);

    const primaries = all<{ id: string }>(db, 'SELECT id FROM contact WHERE is_primary = 1').map((r) => r.id);
    assert.deepEqual(primaries, ['CT_FOUNDER']);

    // Contactability moves the company score, so the two really are wired together.
    assert.ok((derivedOf(db, id).score_raw ?? 0) >= 10);
  });

  test('scoreAll walks every non-merged company and reports progress', async () => {
    const db = newDb('scoreall');
    tx(db, () => {
      for (let i = 0; i < 5; i++) {
        const id = seedCompany(db, { id: `C${i}`, name: `Company ${i}`, domain: `co${i}.test`, headcount: 40 });
        seedReq(db, id, { externalId: 'r1', title: 'Backend Engineer', publishedDaysAgo: 60, compMin: 220_000, compMax: 220_000 });
      }
      // A merged-away row must be skipped entirely.
      seedCompany(db, { id: 'C_MERGED', name: 'Merged Away', domain: 'merged.test', headcount: 40 });
      run(db, `UPDATE company SET canonical_id = 'C0' WHERE id = 'C_MERGED'`);
    });

    const ctx = makeCtx('scoring');
    const outcome: SourceOutcome = await scoreAll(db, ctx);

    assert.equal(outcome.records, 5);
    assert.match(outcome.message, /5 companies scored/);
    assert.equal(get<{ n: number }>(db, `SELECT count(*) AS n FROM company WHERE quality_score IS NOT NULL`)?.n, 5);
    assert.equal(
      get<{ s: string }>(db, `SELECT status AS s FROM company WHERE id = 'C_MERGED'`)?.s,
      'discovered',
      'a merged-away company must not be rescored',
    );
    assert.ok(ctx.progressCalls.length > 0);
    assert.deepEqual(ctx.progressCalls.at(-1), [5, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('requisition diffing', () => {
  test('a req that vanishes is closed, and a req that returns is a repost', () => {
    const db = newDb('diff');
    const id = seedCompany(db, { id: 'C1', name: 'Acme Robotics', domain: 'acme.dev' });

    const first = upsertReqs(db, id, 'greenhouse', [job('a'), job('b')], null, 'acme.dev');
    assert.deepEqual(first, { opened: 2, updated: 0, closed: 0, reposted: 0 });

    // 'b' disappears from the board.
    const second = upsertReqs(db, id, 'greenhouse', [job('a')], null, 'acme.dev');
    assert.equal(second.closed, 1);
    assert.equal(second.updated, 1);
    assert.equal(second.reposted, 0);

    const closed = get<{ closed_at: number | null; repost_count: number }>(
      db,
      `SELECT closed_at, repost_count FROM req WHERE external_id = 'b'`,
    )!;
    assert.ok(closed.closed_at, 'a req that vanished from the board must be closed');
    assert.equal(closed.repost_count, 0);

    // …and comes back. That is a failed search, which is the whole point.
    const third = upsertReqs(db, id, 'greenhouse', [job('a'), job('b')], null, 'acme.dev');
    assert.equal(third.reposted, 1);
    assert.equal(third.updated, 1);
    assert.equal(third.closed, 0);

    const reposted = get<{ closed_at: number | null; repost_count: number }>(
      db,
      `SELECT closed_at, repost_count FROM req WHERE external_id = 'b'`,
    )!;
    assert.equal(reposted.closed_at, null);
    assert.equal(reposted.repost_count, 1);

    // A board that is simply unchanged must not keep inflating repost_count.
    const fourth = upsertReqs(db, id, 'greenhouse', [job('a'), job('b')], null, 'acme.dev');
    assert.equal(fourth.reposted, 0);
    assert.equal(fourth.updated, 2);
    assert.equal(
      get<{ repost_count: number }>(db, `SELECT repost_count FROM req WHERE external_id = 'b'`)?.repost_count,
      1,
    );

    // The daily presence snapshot is what repost_count is reconstructed from.
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req_daily')?.n, 2);
  });

  test('a source only diffs against its own reqs', () => {
    const db = newDb('diff-source');
    const id = seedCompany(db, { id: 'C1', name: 'Acme Robotics', domain: 'acme.dev' });

    upsertReqs(db, id, 'greenhouse', [job('gh1')], null, 'acme.dev');
    upsertReqs(db, id, 'ashby', [job('ash1')], null, 'acme.dev');
    // Re-running greenhouse with nothing must not close the Ashby req.
    const out = upsertReqs(db, id, 'greenhouse', [], null, 'acme.dev');

    assert.equal(out.closed, 1);
    assert.equal(
      get<{ closed_at: number | null }>(db, `SELECT closed_at FROM req WHERE source = 'ashby'`)?.closed_at,
      null,
    );
  });

  test('ingest classifies each req and stores a company-domain contact from the JD', () => {
    const db = newDb('classify');
    const id = seedCompany(db, { id: 'C1', name: 'Acme Robotics', domain: 'acme.dev' });

    upsertReqs(
      db,
      id,
      'greenhouse',
      [
        job('a', {
          title: 'Senior Machine Learning Engineer',
          department: 'Research',
          descriptionText: 'Email hiring@acme.dev to apply. Recruiters at agencyplace.example should not write to us.',
          compMin: 200_000,
          compMax: 260_000,
        }),
      ],
      null,
      'acme.dev',
    );

    const req = get<{
      function_family: string | null;
      seniority: string | null;
      named_contact: string | null;
      estimated_fee_usd: number | null;
      no_agency_disclaimer: number | null;
    }>(db, `SELECT function_family, seniority, named_contact, estimated_fee_usd, no_agency_disclaimer FROM req`)!;

    assert.equal(req.function_family, 'engineering');
    assert.equal(req.seniority, 'senior');
    assert.equal(req.named_contact, 'hiring@acme.dev', 'only an address at the company’s own domain counts');
    assert.equal(req.estimated_fee_usd, Math.round(230_000 * 0.3));
    assert.equal(req.no_agency_disclaimer, 0);

    // The named address becomes a contact, flagged as a role address.
    const contact = get<{ email: string; email_verdict: string; email_source: string }>(
      db,
      'SELECT email, email_verdict, email_source FROM contact',
    )!;
    assert.equal(contact.email, 'hiring@acme.dev');
    assert.equal(contact.email_verdict, 'role');
    assert.equal(contact.email_source, 'greenhouse');
  });

  test('an address at someone else’s domain is never captured from a JD', () => {
    const db = newDb('foreign-email');
    const id = seedCompany(db, { id: 'C1', name: 'Acme Robotics', domain: 'acme.dev' });

    upsertReqs(
      db,
      id,
      'greenhouse',
      [job('a', { descriptionText: 'Apply via jobs@some-ats-relay.example or founder@gmail.com.' })],
      null,
      'acme.dev',
    );

    assert.equal(get<{ named_contact: string | null }>(db, 'SELECT named_contact FROM req')?.named_contact, null);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM contact')?.n, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('classifyNoAgency', () => {
  const REFUSALS = [
    'Please note: Acme does not accept unsolicited resumes from staffing agencies.',
    'No agencies, please.',
    'Acme does not accept agency submissions of any kind.',
    'No recruiters please.',
    'We are not currently working with external recruiting agencies.',
    'Agency submissions are not accepted for this role.',
    'Third-party recruiters are not eligible for any placement fee.',
    'We will not pay any fee for candidates submitted this way.',
    'Resumes sent without a signed written agreement become the property of Acme.',
    'Acme does not accept unsolicited candidate profiles from third-party recruiting firms.',
  ];

  const NOT_REFUSALS = [
    'We work with agencies on select executive searches.',
    'Agency partners welcome — reach out to talent@acme.dev.',
    'You will partner with our recruiting team and our external agency partners.',
    'We are not accepting applications for this role at this time.',
    'This role is not remote and is not open to relocation.',
    'Our recruiters will reach out within a week of your application.',
    'Acme is an equal opportunity employer.',
    '',
  ];

  test('detects real disclaimer phrasings', () => {
    for (const text of REFUSALS) {
      assert.equal(classifyNoAgency(text), true, `should have flagged: ${text}`);
    }
  });

  test('does not trip on agency-friendly or unrelated copy', () => {
    for (const text of NOT_REFUSALS) {
      assert.equal(classifyNoAgency(text), false, `false positive on: ${text}`);
    }
    assert.equal(classifyNoAgency(null), false);
    assert.equal(classifyNoAgency(undefined), false);
  });

  test('still finds the disclaimer in the boilerplate tail of a very long JD', () => {
    const filler = 'We are building the future of widgets. '.repeat(900);
    assert.ok(filler.length > 20_000);
    assert.equal(classifyNoAgency(`${filler}\n\nNo agencies, please.`), true);
    assert.equal(classifyNoAgency(`No agencies, please.\n\n${filler}`), true, 'the head of the document is scanned too');
  });

  test('title classification is stable for the families the UI filters on', () => {
    assert.equal(classifyFunctionFamily('Staff Software Engineer', null), 'engineering');
    assert.equal(classifyFunctionFamily('Applied Scientist', 'Research'), 'data_ml');
    assert.equal(classifyFunctionFamily('Account Executive', null), 'sales');
    assert.equal(classifyFunctionFamily('Office Coordinator', null), null);

    assert.equal(classifySeniority('VP of Engineering'), 'executive');
    assert.equal(classifySeniority('Staff Engineer'), 'staff');
    assert.equal(classifySeniority('Senior Backend Engineer'), 'senior');
    assert.equal(classifySeniority('Backend Engineer'), 'mid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('entity resolution', () => {
  test('eTLD+1 extraction', () => {
    assert.equal(etldPlusOne('https://stripe.com/careers'), 'stripe.com');
    assert.equal(etldPlusOne('https://www.stripe.com'), 'stripe.com');
    assert.equal(etldPlusOne('www.stripe.com'), 'stripe.com');
    assert.equal(etldPlusOne('STRIPE.COM.'), 'stripe.com');
    assert.equal(etldPlusOne('https://jobs.eu.stripe.com:8443/openings?x=1#y'), 'stripe.com');
    assert.equal(etldPlusOne('recruiting@stripe.com'), 'stripe.com');
    assert.equal(etldPlusOne('https://careers.acme.co.uk/jobs'), 'acme.co.uk');

    // Never a company identity.
    assert.equal(etldPlusOne('https://someone.github.io/careers'), null);
    assert.equal(etldPlusOne('https://mystudio.wixsite.com/home'), null);
    assert.equal(etldPlusOne('https://boards.greenhouse.io/acme'), null);
    assert.equal(etldPlusOne('https://www.linkedin.com/company/acme'), null);
    assert.equal(etldPlusOne('founder@gmail.com'), null);
    assert.equal(etldPlusOne('https://acme.vercel.app'), null);

    assert.equal(etldPlusOne('localhost'), null);
    assert.equal(etldPlusOne(''), null);
    assert.equal(etldPlusOne(null), null);
    assert.equal(etldPlusOne('not a hostname at all'), null);
  });

  test('upsertCompany dedupes on eTLD+1 across URL shapes', () => {
    const db = newDb('dedupe');

    const a = upsertCompany(db, { name: 'Stripe', website: 'https://stripe.com/careers' });
    const b = upsertCompany(db, { name: 'Stripe Payments', website: 'https://www.stripe.com' });
    const c = upsertCompany(db, { name: 'Stripe, Inc.', domain: 'stripe.com' });
    const d = upsertCompany(db, { name: 'Stripe', website: 'https://jobs.stripe.com/openings' });

    assert.equal(b, a);
    assert.equal(c, a);
    assert.equal(d, a);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 1);
    assert.equal(get<{ domain: string }>(db, 'SELECT domain FROM company WHERE id = ?', a)?.domain, 'stripe.com');
  });

  test('two different companies are never merged', () => {
    const db = newDb('nomerge');
    const stripe = upsertCompany(db, { name: 'Stripe', website: 'https://stripe.com' });
    const plaid = upsertCompany(db, { name: 'Plaid', website: 'https://plaid.com' });
    const acme = upsertCompany(db, { name: 'Acme Robotics', website: 'https://acme.dev' });

    assert.equal(new Set([stripe, plaid, acme]).size, 3);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 3);
  });

  test('the non-company-domain blocklist prevents keying on a hosting provider', () => {
    const db = newDb('blocklist');

    const alpha = upsertCompany(db, { name: 'Alpha Studio', website: 'https://alpha.wixsite.com/home' });
    const beta = upsertCompany(db, { name: 'Beta Studio', website: 'https://beta.wixsite.com/home' });
    const gamma = upsertCompany(db, { name: 'Gamma Labs', website: 'https://gamma.github.io' });

    assert.equal(new Set([alpha, beta, gamma]).size, 3, 'shared hosting must not collapse three companies into one');
    for (const id of [alpha, beta, gamma]) {
      assert.equal(
        get<{ domain: string | null }>(db, 'SELECT domain FROM company WHERE id = ?', id)?.domain,
        null,
        'a blocklisted host must never become a company identity',
      );
    }
  });

  test('falls back to the normalised name when there is no usable domain', () => {
    const db = newDb('namefallback');
    assert.equal(normName('Acme Robotics, Inc.'), 'acme robotics');
    assert.equal(normName('Acme Robotics LLC'), 'acme robotics');

    const first = upsertCompany(db, { name: 'Acme Robotics, Inc.', website: 'https://acme.wixsite.com' });
    const second = upsertCompany(db, { name: 'Acme Robotics LLC', website: null });
    assert.equal(second, first);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('provenance', () => {
  test('an observation resolves to exactly one winner, and a competing source flags a conflict', () => {
    const db = newDb('provenance');
    const id = upsertCompany(db, { name: 'Provenance Co', domain: 'provco.test' });

    const evidenceId = storeRaw(db, 'yc', 'https://yc.test/companies', 200, '{"team_size":40}');
    assert.ok(evidenceId, 'evidence row must exist before an observation can reference it');

    observeCompany(db, id, 'headcount', 40, 'yc', evidenceId, 'medium');

    const resolvedRows = () =>
      all<{ value: string | null; source: string; conflicting: number; obs_id: number }>(
        db,
        `SELECT value, source, conflicting, obs_id FROM field_resolved
          WHERE entity = 'company' AND entity_id = ? AND field = 'headcount'`,
        id,
      );

    assert.equal(resolvedRows().length, 1);
    assert.equal(resolvedRows()[0]!.value, '40');
    assert.equal(resolvedRows()[0]!.source, 'yc');
    assert.equal(resolvedRows()[0]!.conflicting, 0);
    assert.equal(get<{ headcount: number }>(db, 'SELECT headcount FROM company WHERE id = ?', id)?.headcount, 40);

    // The observation points at the bytes it came from.
    const obs = get<{ evidence_id: number | null; source: string }>(
      db,
      'SELECT evidence_id, source FROM field_observation WHERE id = ?',
      resolvedRows()[0]!.obs_id,
    )!;
    assert.equal(obs.evidence_id, evidenceId);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM raw_response WHERE id = ?', evidenceId)?.n, 1);

    // A second source disagrees. YC outranks LinkedIn, so the value holds — but
    // the disagreement is surfaced rather than swallowed.
    observeCompany(db, id, 'headcount', 120, 'linkedin', null, 'medium');
    assert.equal(resolvedRows().length, 1, 'field_resolved must stay one row per field');
    assert.equal(resolvedRows()[0]!.conflicting, 1);
    assert.equal(resolvedRows()[0]!.value, '40');
    assert.equal(resolvedRows()[0]!.source, 'yc');
    assert.equal(get<{ headcount: number }>(db, 'SELECT headcount FROM company WHERE id = ?', id)?.headcount, 40);

    // A human edit ends the argument.
    observeCompany(db, id, 'headcount', 88, 'human', null, 'high');
    assert.equal(resolvedRows()[0]!.conflicting, 0);
    assert.equal(resolvedRows()[0]!.value, '88');
    assert.equal(resolvedRows()[0]!.source, 'human');
    assert.equal(get<{ headcount: number }>(db, 'SELECT headcount FROM company WHERE id = ?', id)?.headcount, 88);

    // Nothing was destroyed: every claim is still on the record.
    assert.equal(
      get<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM field_observation WHERE entity = 'company' AND entity_id = ? AND field = 'headcount'`,
        id,
      )?.n,
      3,
    );
  });

  test('one source updating its own value is new information, not a conflict', () => {
    const db = newDb('selfupdate');
    const id = upsertCompany(db, { name: 'Growing Co', domain: 'growing.test' });

    observeCompany(db, id, 'headcount', 40, 'yc', null, 'medium');
    observeCompany(db, id, 'headcount', 80, 'yc', null, 'medium');

    const row = get<{ value: string; conflicting: number }>(
      db,
      `SELECT value, conflicting FROM field_resolved WHERE entity = 'company' AND entity_id = ? AND field = 'headcount'`,
      id,
    )!;
    assert.equal(row.value, '80');
    assert.equal(row.conflicting, 0);
  });

  test('resolveEntityField returns null when nothing has been observed', () => {
    const db = newDb('empty-resolve');
    const id = upsertCompany(db, { name: 'Blank Co', domain: 'blank.test' });
    assert.equal(resolveEntityField(db, 'company', id, 'industry'), null);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM field_resolved')?.n, 0);
  });

  test('storeRaw dedupes identical bodies by content hash', () => {
    const db = newDb('rawdedupe');
    const body = '{"jobs":[]}';
    const first = storeRaw(db, 'greenhouse', 'https://boards.test/a', 200, body);
    const second = storeRaw(db, 'greenhouse', 'https://boards.test/b', 200, body);
    const other = storeRaw(db, 'greenhouse', 'https://boards.test/c', 200, '{"jobs":[1]}');

    assert.equal(second, first, 're-fetching an unchanged board must not store a second copy');
    assert.notEqual(other, first);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM raw_response')?.n, 2);
    assert.equal(storeRaw(db, 'greenhouse', 'https://boards.test/d', 200, null), null);
  });

  test('a raw observation can be written without touching a denormalised column', () => {
    const db = newDb('rawobs');
    const id = upsertCompany(db, { name: 'Obs Co', domain: 'obsco.test' });

    const obsId = writeObservation(db, 'company', id, 'notAColumn', 'value', 'yc', null, 'low');
    assert.ok(obsId > 0);
    const winner = resolveEntityField(db, 'company', id, 'notAColumn');
    assert.equal(winner?.value, 'value');
    assert.equal(winner?.conflicting, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The only test in this file allowed near the network. Off unless asked for.
// ─────────────────────────────────────────────────────────────────────────────

describe('live sources', () => {
  test(
    'parses a real Greenhouse board',
    { skip: !process.env.RECRUITAI_NET ? 'set RECRUITAI_NET=1 to run network tests' : false },
    async () => {
      const res = await fetchGreenhouse('anthropic', { withContent: true });
      assert.ok(res.ok, `fetch failed: ${res.error ?? res.httpStatus}`);
      assert.ok(res.data, 'no board returned');
      assert.equal(res.data.platform, 'greenhouse');
      assert.ok(res.data.jobs.length > 0, 'a live board should have at least one job');

      for (const j of res.data.jobs) {
        assert.ok(j.externalId, 'every job needs a stable external id');
        assert.ok(j.title, 'every job needs a title');
        assert.match(j.url, /^https?:\/\//);
      }

      // And the parsed board survives a real ingest.
      const db = newDb('greenhouse-live');
      const id = upsertCompany(db, { name: 'Anthropic', domain: 'anthropic.com' });
      const evidenceId = storeRaw(db, 'greenhouse', 'https://boards-api.greenhouse.io', 200, res.data.rawBody);
      const out = upsertReqs(db, id, 'greenhouse', res.data.jobs, evidenceId, 'anthropic.com');
      assert.equal(out.opened, res.data.jobs.length);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req')?.n, res.data.jobs.length);
    },
  );
});
