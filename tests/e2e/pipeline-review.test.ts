/**
 * Regressions for pipeline defects that put WRONG data in the database.
 *
 * The failure mode this file exists to prevent is the expensive one: the
 * operator opens a record, believes what it says, and emails the wrong person
 * about roles that were never theirs. Every test below reproduces a shape that
 * was accepted silently — a chimera company built from three real ones, a
 * truncated board read as a mass close, and an evidence row that does not
 * contain the bytes the claim was read out of.
 *
 * Real database, no network: `globalThis.fetch` is routed per-URL per test.
 */

// Must come first: patches require('electron') before any app module is evaluated.
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { initDb, closeDb, all, get, run, type Db } from '../../src/main/db/index.js';
import {
  ingestCareersCrawl,
  upsertCompany,
  upsertReqs,
  findCompany,
} from '../../src/main/pipeline/ingest.js';
import type { DiscoveredJob } from '../../src/shared/types.js';
import type { RunCtx } from '../../src/main/pipeline/run.js';

installElectronStub();

let tmpRoot = '';
let seq = 0;

function newDb(name: string): Db {
  closeDb();
  return initDb(path.join(tmpRoot, `${name}-${seq++}.db`));
}

function makeCtx(key: RunCtx['key'] = 'careers_crawl'): RunCtx {
  return { key, log: () => {}, progress: () => {}, cancelled: () => false };
}

type Route = (url: string) => Response;

async function withRoutes<T>(route: Route, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => route(String(input))) as unknown as typeof globalThis.fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

const job = (externalId: string, over: Partial<DiscoveredJob> = {}): DiscoveredJob => ({
  externalId,
  title: `Backend Engineer ${externalId}`,
  url: `https://boards.test/jobs/${externalId}`,
  ...over,
});

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-review-test-'));
});

after(() => {
  closeDb();
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows holds handles past close() long enough to defeat retries. */
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Entity resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('entity resolution: a shared name is not a shared identity', () => {
  test('two companies with the same name and different domains stay two rows', () => {
    const db = newDb('scout');

    // The real case, from the dev database: three distinct YC companies called
    // "Scout" collapsed into one row whose batch, headcount and industry were
    // whichever one was ingested last. Every claim came from the same source,
    // so `conflicting` never fired and nothing surfaced it.
    const w22 = upsertCompany(db, { name: 'Scout', website: 'http://scouthealth.com' });
    const w23 = upsertCompany(db, { name: 'Scout', website: 'https://thedailyscout.com' });
    const w24 = upsertCompany(db, { name: 'Scout', website: 'https://cpgscout.ai/' });

    assert.equal(new Set([w22, w23, w24]).size, 3, 'three companies, three rows');
    assert.deepEqual(
      all<{ domain: string }>(db, 'SELECT domain FROM company ORDER BY domain').map((r) => r.domain),
      ['cpgscout.ai', 'scouthealth.com', 'thedailyscout.com'],
      'each row keeps its own identity',
    );

    // Re-ingesting the same directory must converge, not fan out further.
    assert.equal(upsertCompany(db, { name: 'Scout', website: 'http://scouthealth.com' }), w22);
    assert.equal(upsertCompany(db, { name: 'Scout', domain: 'cpgscout.ai' }), w24);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 3);
  });

  test('a name still adopts a row that has no domain to contradict it', () => {
    const db = newDb('adopt');
    // A blocklisted host yields no domain, so the row is keyed on name alone.
    const first = upsertCompany(db, { name: 'Acme Robotics, Inc.', website: 'https://acme.wixsite.com' });

    assert.equal(findCompany(db, { name: 'Acme Robotics LLC' }), first, 'nothing contradicts the name');
    assert.equal(
      findCompany(db, { name: 'Acme Robotics LLC', domain: 'acme.dev' }),
      first,
      'a domain-less row is where a newly-learned domain belongs',
    );
    assert.equal(upsertCompany(db, { name: 'Acme Robotics LLC', domain: 'acme.dev' }), first);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 1);
  });

  test('a company whose normalised name is two characters is still idempotent', () => {
    const db = newDb('shortname');
    // '&AI' normalises to 'ai'. Under a 3-character floor it matched nothing
    // and a fresh row was inserted on every single run.
    const a = upsertCompany(db, { name: '&AI' });
    const b = upsertCompany(db, { name: '&AI' });
    assert.equal(b, a);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM company')?.n, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The req differ
// ─────────────────────────────────────────────────────────────────────────────

describe('requisition diffing: absence only counts when we saw the whole board', () => {
  test('a prefix of a board opens what it contains and closes nothing', () => {
    const db = newDb('prefix');
    const id = upsertCompany(db, { name: 'Paged Co', domain: 'paged.test' });

    upsertReqs(db, id, 'smartrecruiters', [job('a'), job('b'), job('c')], null, 'paged.test');

    const partial = upsertReqs(db, id, 'smartrecruiters', [job('a')], null, 'paged.test', { closeMissing: false });
    assert.equal(partial.closed, 0, 'the pages we never received are not evidence of a close');
    assert.equal(partial.updated, 1);
    assert.equal(
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE closed_at IS NULL')?.n,
      3,
      'every req stays open',
    );

    // …and a genuinely complete board still closes, so the guard has not simply
    // disabled the differ.
    const complete = upsertReqs(db, id, 'smartrecruiters', [job('a')], null, 'paged.test');
    assert.equal(complete.closed, 2);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE closed_at IS NULL')?.n, 1);
  });

  test('a prefix never manufactures a repost', () => {
    const db = newDb('prefix-repost');
    const id = upsertCompany(db, { name: 'Repost Co', domain: 'repost.test' });

    upsertReqs(db, id, 'smartrecruiters', [job('a'), job('b')], null, 'repost.test');
    // Truncated, then whole again. Without the guard this reads as one close
    // followed by one repost — a "failed search" claim we would put in an email.
    upsertReqs(db, id, 'smartrecruiters', [job('a')], null, 'repost.test', { closeMissing: false });
    upsertReqs(db, id, 'smartrecruiters', [job('a'), job('b')], null, 'repost.test');

    assert.equal(
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE repost_count > 0')?.n,
      0,
      'no req may be reported as reposted off a fetch that never completed',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The careers crawl
// ─────────────────────────────────────────────────────────────────────────────

describe('careers crawl', () => {
  const CAREERS_HTML =
    '<html><body><a href="https://careers.smartrecruiters.com/PagedCo">Open roles</a></body></html>';

  const srPage = (ids: string[]) =>
    new Response(JSON.stringify({ content: ids.map((id) => ({ id, name: `Role ${id}` })), totalFound: 150 }), {
      status: 200,
    });

  /** Company with reqs already on record and no ats_token, i.e. a crawl target. */
  function seedCrawlTarget(db: Db): string {
    const id = upsertCompany(db, { name: 'Paged Co', domain: 'paged.test', website: 'https://paged.test' });
    const jobs = Array.from({ length: 150 }, (_, i) => job(`p${i}`));
    upsertReqs(db, id, 'smartrecruiters', jobs, null, 'paged.test');
    return id;
  }

  test('a partially-fetched board recovered from a careers page cannot close a req', async () => {
    const db = newDb('crawl-partial');
    const companyId = seedCrawlTarget(db);

    await withRoutes(
      (url) => {
        if (url.startsWith('https://paged.test')) return new Response(CAREERS_HTML, { status: 200 });
        if (url.includes('api.smartrecruiters.com')) {
          // Page 1 lands, page 2 is rate-limited: `jobs` is a prefix, and the
          // 50 postings we never saw are still open roles.
          return url.includes('offset=0')
            ? srPage(Array.from({ length: 100 }, (_, i) => `p${i}`))
            : new Response('rate limited', { status: 429 });
        }
        return new Response('not found', { status: 404 });
      },
      async () => {
        await ingestCareersCrawl(db, makeCtx());
      },
    );

    assert.equal(
      get<{ t: string | null }>(db, 'SELECT ats_token AS t FROM company WHERE id = ?', companyId)?.t,
      'PagedCo',
      'the token is still recovered — a partial board is not a failed crawl',
    );
    assert.equal(
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ? AND closed_at IS NULL', companyId)?.n,
      150,
      'no req may close off a fetch that never completed',
    );
    assert.equal(
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ? AND repost_count > 0', companyId)?.n,
      0,
    );
  });

  test('each claim cites the document it was actually read out of', async () => {
    const db = newDb('crawl-evidence');
    const companyId = upsertCompany(db, {
      name: 'Paged Co',
      domain: 'paged.test',
      website: 'https://paged.test',
    });

    await withRoutes(
      (url) => {
        if (url.startsWith('https://paged.test')) return new Response(CAREERS_HTML, { status: 200 });
        if (url.includes('api.smartrecruiters.com')) {
          return url.includes('offset=0') ? srPage(['p0', 'p1']) : new Response('not found', { status: 404 });
        }
        return new Response('not found', { status: 404 });
      },
      async () => {
        await ingestCareersCrawl(db, makeCtx());
      },
    );

    const bodyOf = (evidenceId: number) => {
      const row = get<{ url: string; source: string; body: Uint8Array }>(
        db,
        'SELECT url, source, body FROM raw_response WHERE id = ?',
        evidenceId,
      )!;
      return { url: row.url, source: row.source, body: gunzipSync(Buffer.from(row.body)).toString('utf8') };
    };

    const tokenObs = get<{ evidence_id: number }>(
      db,
      `SELECT evidence_id FROM field_observation
        WHERE entity = 'company' AND entity_id = ? AND field = 'atsToken'`,
      companyId,
    )!;
    const tokenEvidence = bodyOf(tokenObs.evidence_id);
    assert.equal(tokenEvidence.source, 'careers_page');
    assert.equal(tokenEvidence.url, 'https://paged.test/careers');
    assert.equal(tokenEvidence.body, CAREERS_HTML, 'the token was read out of this page, so this is its evidence');

    // The reqs came from the ATS payload, which is a different document at a
    // different URL. Filing them under the careers page — or, when no payload
    // existed, under a "body" that was just the URL string — made evidence_id
    // point at bytes that never contained the claim.
    const boardRow = get<{ id: number; url: string }>(
      db,
      `SELECT id, url FROM raw_response WHERE source = 'smartrecruiters'`,
    )!;
    assert.equal(boardRow.url, 'https://api.smartrecruiters.com/v1/companies/PagedCo/postings');
    const boardBody = bodyOf(boardRow.id).body;
    assert.match(boardBody, /"content"/, 'the ATS payload is stored as its own evidence row');
    assert.notEqual(boardRow.id, tokenObs.evidence_id, 'two documents, two evidence rows');

    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ?', companyId)?.n, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

test('running the same board twice changes nothing', () => {
  const db = newDb('idempotent');
  const id = upsertCompany(db, { name: 'Steady Co', domain: 'steady.test', website: 'https://steady.test' });
  const jobs = [job('a', { compMin: 180_000, compMax: 220_000 }), job('b')];

  upsertReqs(db, id, 'greenhouse', jobs, null, 'steady.test');
  const snapshot = () =>
    all<Record<string, unknown>>(
      db,
      'SELECT external_id, title, comp_min, comp_max, estimated_fee_usd, closed_at, repost_count FROM req ORDER BY external_id',
    );
  const before = JSON.stringify(snapshot());

  const second = upsertReqs(db, id, 'greenhouse', jobs, null, 'steady.test');
  assert.deepEqual(second, { opened: 0, updated: 2, closed: 0, reposted: 0 });
  assert.equal(JSON.stringify(snapshot()), before, 'a second identical fetch must not flip a single field');
  assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req')?.n, 2);
});
