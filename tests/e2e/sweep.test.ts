/**
 * ATS sweep + careers-crawl end-to-end: real database, stubbed network.
 *
 * These pin the operational properties that only show up at run scale — a
 * single rate-limited platform must not end the run for everyone else, partial
 * work must be durable before the run finishes, and a resolved board must keep
 * being re-read afterwards or the close/repost machinery in upsertReqs never
 * fires again. Each of these failed silently in production before it failed a
 * test here.
 *
 * No network: `globalThis.fetch` is routed per-URL for the duration of a test.
 */

// Must come first: patches require('electron') before any app module is evaluated.
import { installElectronStub } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, get, run, type Db } from '../../src/main/db/index.js';
import { ingestAtsSweep, ingestCareersCrawl, upsertCompany } from '../../src/main/pipeline/ingest.js';
import type { RunCtx, SourceOutcome } from '../../src/main/pipeline/run.js';

installElectronStub();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let tmpRoot = '';
let seq = 0;

function newDb(name: string): Db {
  closeDb();
  return initDb(path.join(tmpRoot, `${name}-${seq++}.db`));
}

interface CapturedCtx extends RunCtx {
  logs: { level: string; message: string }[];
  cancel(): void;
}

function makeCtx(key: RunCtx['key'] = 'ats_sweep'): CapturedCtx {
  const logs: { level: string; message: string }[] = [];
  let cancelled = false;
  return {
    key,
    logs,
    cancel: () => {
      cancelled = true;
    },
    log: (level, message) => logs.push({ level, message }),
    progress: () => {},
    cancelled: () => cancelled,
  };
}

type Route = (url: string) => Response | Promise<Response>;

/** Swaps in a URL-routing fetch, runs `body`, and always restores the real one. */
async function withRoutes<T>(route: Route, body: (requested: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    return route(url);
  }) as unknown as typeof globalThis.fetch;
  try {
    return await body(requested);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const html = (body: string) => new Response(body, { status: 200 });
const notFound = () => new Response('not found', { status: 404 });

/** A minimal Greenhouse board payload carrying the given job ids. */
const ghJobs = (ids: number[]) =>
  json({
    jobs: ids.map((id) => ({
      id,
      title: `Backend Engineer ${id}`,
      absolute_url: `https://example.test/jobs/${id}`,
    })),
  });

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-sweep-test-'));
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

describe('careers_crawl sweep behaviour', () => {
  test('one platform 429ing does not end the careers crawl for the others', async () => {
    const db = newDb('crawl-block');
    upsertCompany(db, { name: 'Alpha', domain: 'alpha.test', website: 'https://alpha.test' });
    upsertCompany(db, { name: 'Beta', domain: 'beta.test', website: 'https://beta.test' });
    upsertCompany(db, { name: 'Gamma', domain: 'gamma.test', website: 'https://gamma.test' });

    let resolveGate!: () => void;
    const workable429Served = new Promise<void>((r) => {
      resolveGate = r;
    });
    // Beta and Gamma only proceed once Alpha's 429 has been served (plus a
    // breath for Alpha's worker to record the block), so the ordering under
    // test is deterministic despite the concurrent workers.
    const afterBlock = async () => {
      await workable429Served;
      await new Promise((r) => setTimeout(r, 100));
    };

    let gammaBoardFetched = false;

    await withRoutes(
      async (url) => {
        if (url.startsWith('https://alpha.test')) return html('<a href="https://alpha.workable.com">Jobs</a>');
        if (url.startsWith('https://beta.test')) {
          await afterBlock();
          return html('<a href="https://boards.greenhouse.io/beta">Jobs</a>');
        }
        if (url.startsWith('https://gamma.test')) {
          await afterBlock();
          return html('<a href="https://gamma.workable.com">Jobs</a>');
        }
        if (url.includes('apply.workable.com/api/v1/widget/accounts/alpha')) {
          resolveGate();
          return new Response('rate limited', { status: 429 });
        }
        if (url.includes('apply.workable.com/api/v1/widget/accounts/gamma')) {
          gammaBoardFetched = true;
          return json({ name: 'Gamma', jobs: [] });
        }
        if (url.includes('boards-api.greenhouse.io/v1/boards/beta/jobs')) return ghJobs([11]);
        throw new Error(`unexpected URL in test: ${url}`);
      },
      async () => {
        const outcome: SourceOutcome = await ingestCareersCrawl(db, makeCtx('careers_crawl'));
        assert.equal(outcome.records, 3, 'every company that exposed a token must be recorded');
      },
    );

    // Beta's greenhouse board was fetched and ingested after the workable 429.
    const betaId = get<{ id: string }>(db, `SELECT id FROM company WHERE domain = 'beta.test'`)!.id;
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ?', betaId)?.n, 1);

    // Alpha and Gamma keep their resolved platform+token for the refresh pass…
    for (const domain of ['alpha.test', 'gamma.test']) {
      const co = get<{ ats_platform: string | null; ats_token: string | null }>(
        db,
        'SELECT ats_platform, ats_token FROM company WHERE domain = ?',
        domain,
      )!;
      assert.equal(co.ats_platform, 'workable', `${domain} must still record its platform`);
      assert.ok(co.ats_token, `${domain} must still record its token`);
    }
    // …but the blocked platform was never asked again this run.
    assert.equal(gammaBoardFetched, false, 'a 429ed platform must not be fetched again this run');
  });

  test('the careers crawl flushes results incrementally, not only at the end', async () => {
    const db = newDb('crawl-flush');
    const N = 40;
    for (let i = 0; i < N; i++) {
      upsertCompany(db, { name: `Flush Co ${i}`, domain: `flushco${i}.test`, website: `https://flushco${i}.test` });
    }

    const tokenCount = () =>
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM company WHERE ats_token IS NOT NULL')?.n ?? 0;
    let maxSeenMidRun = 0;

    await withRoutes(
      (url) => {
        // Every fetch observes what is already durable. If nothing were
        // flushed until the very end, this would stay 0 for the entire run.
        maxSeenMidRun = Math.max(maxSeenMidRun, tokenCount());
        const m = url.match(/^https:\/\/(flushco\d+)\.test/);
        if (m) return html(`<a href="https://boards.greenhouse.io/${m[1]}">Jobs</a>`);
        const b = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/(flushco\d+)\/jobs/);
        if (b) return ghJobs([1]);
        throw new Error(`unexpected URL in test: ${url}`);
      },
      async () => {
        const outcome = await ingestCareersCrawl(db, makeCtx('careers_crawl'));
        assert.equal(outcome.records, N);
      },
    );

    // Pinned to "some rows landed durably before the run finished", NOT to the
    // exact flush threshold — SWEEP_FLUSH_EVERY is a tuning constant, and a
    // safe change to it must not fail this test.
    assert.ok(
      maxSeenMidRun > 0 && maxSeenMidRun < N,
      `a flush must land while fetches are still being served (saw ${maxSeenMidRun} of ${N} rows mid-run)`,
    );
    assert.equal(tokenCount(), N);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req')?.n, N);
  });

  test('a crawl cancelled mid-way keeps the boards it already found', async () => {
    const db = newDb('crawl-cancel');
    const N = 30;
    for (let i = 0; i < N; i++) {
      upsertCompany(db, { name: `Cancel Co ${i}`, domain: `cancelco${i}.test`, website: `https://cancelco${i}.test` });
    }

    const ctx = makeCtx('careers_crawl');
    let boardsServed = 0;

    await withRoutes(
      (url) => {
        const m = url.match(/^https:\/\/(cancelco\d+)\.test/);
        if (m) return html(`<a href="https://boards.greenhouse.io/${m[1]}">Jobs</a>`);
        const b = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/(cancelco\d+)\/jobs/);
        if (b) {
          // Kill the run once a third of the boards have been served — the
          // work already done must survive the stop.
          if (++boardsServed === 10) ctx.cancel();
          return ghJobs([1]);
        }
        throw new Error(`unexpected URL in test: ${url}`);
      },
      async () => {
        const outcome = await ingestCareersCrawl(db, ctx);
        assert.ok(outcome.records > 0, 'the boards found before the cancel must be counted');
        assert.ok(outcome.records < N, 'the cancel must actually have cut the run short');
      },
    );

    const persisted = get<{ n: number }>(db, 'SELECT count(*) AS n FROM company WHERE ats_token IS NOT NULL')?.n ?? 0;
    assert.ok(persisted >= 10, `partial work must be durable after a cancel (got ${persisted})`);
    assert.ok(persisted < N);
    assert.equal(persisted, get<{ n: number }>(db, 'SELECT count(*) AS n FROM req')?.n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** A SmartRecruiters postings page. */
const srPage = (ids: number[]) =>
  json({
    content: ids.map((id) => ({ id: String(id), name: `Role ${id}` })),
    totalFound: ids.length,
  });

describe('ats_sweep refresh pass', () => {
  test('a partially-fetched SmartRecruiters board never reaches the differ', async () => {
    const db = newDb('sweep-partial');
    const companyId = upsertCompany(db, { name: 'Paged Co', domain: 'paged-sr.test', website: 'https://paged-sr.test' });
    run(db, `UPDATE company SET ats_platform = 'smartrecruiters', ats_token = 'pagedco' WHERE id = ?`, companyId);

    const full = Array.from({ length: 150 }, (_, i) => i + 1);
    let pageTwoRateLimited = false;
    const route: Route = (url) => {
      if (!url.includes('api.smartrecruiters.com')) throw new Error(`unexpected URL: ${url}`);
      if (url.includes('offset=0')) return srPage(full.slice(0, 100));
      if (pageTwoRateLimited) return new Response('rate limited', { status: 429 });
      return srPage(full.slice(100));
    };

    // Run 1 — both pages arrive; 150 reqs ingest via the refresh.
    await withRoutes(route, async () => {
      await ingestAtsSweep(db, makeCtx());
    });
    const openCount = () =>
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ? AND closed_at IS NULL', companyId)?.n ?? 0;
    assert.equal(openCount(), 150);

    // Run 2 — page 2 429s. The fetched prefix is a PARTIAL board: the differ
    // would read the missing 50 as closes, then re-open them next run as fake
    // "reposts" that end up quoted in outreach copy. It must be skipped whole.
    pageTwoRateLimited = true;
    await withRoutes(route, async () => {
      await ingestAtsSweep(db, makeCtx());
    });
    assert.equal(openCount(), 150, 'no req may close off a partial fetch');
    assert.equal(
      get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ? AND repost_count > 0', companyId)?.n,
      0,
      'and none may later count as reposted',
    );
  });

  test('three consecutive 404s close a dead board through the normal differ', async () => {
    const db = newDb('sweep-dead');
    const companyId = upsertCompany(db, { name: 'Gone Co', domain: 'gone-sr.test', website: 'https://gone-sr.test' });
    run(db, `UPDATE company SET ats_platform = 'greenhouse', ats_token = 'goneco' WHERE id = ?`, companyId);

    let alive = true;
    const route: Route = (url) => {
      if (url.includes('boards-api.greenhouse.io')) return alive ? ghJobs([1, 2]) : notFound();
      throw new Error(`unexpected URL: ${url}`);
    };

    await withRoutes(route, async () => {
      await ingestAtsSweep(db, makeCtx());
    });
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ? AND closed_at IS NULL', companyId)?.n, 2);

    alive = false;
    for (let pass = 1; pass <= 3; pass++) {
      await withRoutes(route, async () => {
        await ingestAtsSweep(db, makeCtx());
      });
      const open = get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ? AND closed_at IS NULL', companyId)?.n;
      if (pass < 3) assert.equal(open, 2, `pass ${pass}: a 404 alone must not close anything`);
      else assert.equal(open, 0, 'the third consecutive 404 finally closes the dead board');
    }
    assert.equal(
      get<{ t: string | null }>(db, 'SELECT ats_token AS t FROM company WHERE id = ?', companyId)?.t,
      null,
      'the dead token is cleared so the careers crawl can re-resolve it',
    );
  });

  test('a resolved board keeps being re-fetched: closes and reposts are detected', async () => {
    const db = newDb('sweep-refresh');
    upsertCompany(db, { name: 'Acme', domain: 'acme.dev', website: 'https://acme.dev' });
    // A platform we have no adapter for must be skipped without a fetch.
    const otherId = upsertCompany(db, { name: 'Elsewhere', domain: 'elsewhere.test', website: 'https://elsewhere.test' });
    run(db, `UPDATE company SET ats_platform = 'workday', ats_token = 'elsewhere' WHERE id = ?`, otherId);

    let ghIds = [1, 2, 3];
    const route: Route = (url) => {
      if (url.includes('api.ashbyhq.com')) return notFound();
      if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) return ghJobs(ghIds);
      throw new Error(`unexpected URL in test: ${url}`);
    };

    // Run 1 — discovery resolves the board and ingests three reqs.
    await withRoutes(route, async () => {
      const outcome = await ingestAtsSweep(db, makeCtx());
      assert.match(outcome.message, /1 ATS boards discovered/);
    });
    const acmeId = get<{ id: string }>(db, `SELECT id FROM company WHERE domain = 'acme.dev'`)!.id;
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM req WHERE company_id = ?', acmeId)?.n, 3);

    const reqRow = (externalId: string) =>
      get<{ closed_at: number | null; repost_count: number }>(
        db,
        'SELECT closed_at, repost_count FROM req WHERE company_id = ? AND external_id = ?',
        acmeId,
        externalId,
      )!;

    // Run 2 — nothing left to discover; the refresh re-reads the board, sees a
    // req gone from it, and closes it.
    ghIds = [1, 2];
    await withRoutes(route, async () => {
      const outcome = await ingestAtsSweep(db, makeCtx());
      assert.match(outcome.message, /0 ATS boards discovered, 1 refreshed \(1 closed, 0 reposted\)/);
    });
    assert.ok(reqRow('3').closed_at, 'the vanished req must be closed by the refresh');
    assert.equal(reqRow('1').closed_at, null);
    assert.equal(reqRow('2').closed_at, null);

    // Run 3 — the req comes back: that is a repost, the strongest signal there is.
    ghIds = [1, 2, 3];
    await withRoutes(route, async () => {
      const outcome = await ingestAtsSweep(db, makeCtx());
      assert.match(outcome.message, /1 refreshed \(0 closed, 1 reposted\)/);
    });
    assert.equal(reqRow('3').closed_at, null, 'a reposted req is open again');
    assert.equal(reqRow('3').repost_count, 1);
  });

  test('the refresh pass skips a platform that got blocked earlier in the run', async () => {
    const db = newDb('sweep-refresh-blocked');
    // A known workable board from a previous run…
    const knownId = upsertCompany(db, { name: 'Known', domain: 'known.test', website: 'https://known.test' });
    run(db, `UPDATE company SET ats_platform = 'workable', ats_token = 'known' WHERE id = ?`, knownId);
    // …and one unresolved company whose probe will trip workable's limiter.
    upsertCompany(db, { name: 'Fresh', domain: 'fresh.test', website: 'https://fresh.test' });

    let knownFetches = 0;
    await withRoutes(
      (url) => {
        if (url.includes('apply.workable.com/api/v1/widget/accounts/known')) {
          knownFetches++;
          return json({ name: 'Known', jobs: [] });
        }
        if (url.includes('apply.workable.com')) return new Response('rate limited', { status: 429 });
        return notFound();
      },
      async () => {
        await ingestAtsSweep(db, makeCtx());
      },
    );

    assert.equal(knownFetches, 0, 'a platform that 429ed during discovery must not be re-asked by the refresh');
  });
});
