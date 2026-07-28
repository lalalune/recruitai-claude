/**
 * ATS adapters, driven by real captured responses.
 *
 * tests/fixtures/*.json are golden files: trimmed but otherwise verbatim
 * captures of the live Greenhouse, Ashby and Lever endpoints. The point of
 * asserting exact field mappings against them is that when a vendor silently
 * renames or re-nests a field, a parser test fails loudly here instead of the
 * pipeline quietly collecting 4,886 requisitions with empty titles and no comp.
 *
 * No network: `globalThis.fetch` is stubbed to serve the fixture body.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROBE_ORDER,
  fetchAshby,
  fetchGreenhouse,
  fetchLever,
  parseCompRange,
} from '../../src/main/sources/ats.js';

import greenhouseFixture from '../fixtures/greenhouse.json';
import ashbyFixture from '../fixtures/ashby.json';
import leverFixture from '../fixtures/lever.json';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

async function serving<T>(
  payload: unknown,
  run: (requested: string[]) => Promise<T>,
  status = 200,
): Promise<T> {
  const real = globalThis.fetch;
  const requested: string[] = [];
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input));
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  try {
    return await run(requested);
  } finally {
    globalThis.fetch = real;
  }
}

/** Structured deep clone so a mutation in one test cannot leak into another. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ─────────────────────────────────────────────────────────────────────────────
// Greenhouse
// ─────────────────────────────────────────────────────────────────────────────

test('greenhouse fixture still has the shape the adapter reads', () => {
  assert.ok(Array.isArray(greenhouseFixture.jobs));
  assert.ok(greenhouseFixture.jobs.length >= 3);
  for (const j of greenhouseFixture.jobs) {
    assert.equal(typeof j.id, 'number');
    assert.equal(typeof j.title, 'string');
    assert.equal(typeof j.absolute_url, 'string');
    assert.equal(typeof j.location.name, 'string');
    assert.equal(typeof j.updated_at, 'string');
    assert.equal(typeof j.first_published, 'string');
    assert.equal(typeof j.content, 'string');
    assert.ok(Array.isArray(j.departments) && typeof j.departments[0]!.name === 'string');
  }
});

test('fetchGreenhouse maps every documented field exactly', async () => {
  await serving(greenhouseFixture, async (requested) => {
    const result = await fetchGreenhouse('anthropic', { withContent: true });

    assert.equal(requested[0], 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true');
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);

    const board = result.data!;
    assert.equal(board.platform, 'greenhouse');
    assert.equal(board.token, 'anthropic');
    assert.equal(board.jobs.length, greenhouseFixture.jobs.length);
    assert.equal(board.rawBody, JSON.stringify(greenhouseFixture));

    const job = board.jobs[0]!;
    // id (number) -> externalId (string): the DB key is TEXT, and a numeric key
    // here would collide with Ashby/Lever UUIDs on re-import.
    assert.equal(job.externalId, '5215052008');
    assert.equal(typeof job.externalId, 'string');
    assert.equal(job.title, 'Amazon GTM Partnership, Startups');
    assert.equal(job.url, 'https://job-boards.greenhouse.io/anthropic/jobs/5215052008');
    assert.equal(job.location, 'San Francisco, CA | New York City, NY | Seattle, WA');
    assert.equal(job.department, 'Sales');
    assert.equal(job.publishedAt, '2026-05-11T17:58:31-04:00');
    assert.equal(job.updatedAt, '2026-07-14T18:35:00-04:00');

    const fellows = board.jobs[1]!;
    assert.equal(fellows.department, 'AI Research & Engineering');
    assert.equal(fellows.publishedAt, '2025-12-11T12:27:23-05:00');
    assert.equal(fellows.location, 'London, UK; Ontario, CAN; Remote-Friendly, United States; San Francisco, CA');
    return null;
  });
});

test('fetchGreenhouse decodes entity-escaped HTML into plain description text', async () => {
  await serving(greenhouseFixture, async () => {
    const board = (await fetchGreenhouse('anthropic', { withContent: true })).data!;
    const text = board.jobs[0]!.descriptionText!;

    assert.equal(typeof text, 'string');
    assert.ok(text.length > 100);
    assert.ok(text.includes('About Anthropic'), 'headings must survive tag stripping');
    assert.ok(!text.includes('&lt;'), 'HTML entities must be decoded before stripping');
    assert.ok(!text.includes('&quot;'));
    assert.ok(!/<[a-z][^>]*>/i.test(text), `tags leaked into description: ${text.slice(0, 120)}`);
    assert.ok(!text.includes('content-intro'), 'class attributes must not leak into the text');
    assert.equal(text, text.trim());
  });
});

test('fetchGreenhouse omits content when not requested', async () => {
  const withoutContent = { jobs: greenhouseFixture.jobs.map(({ content, ...rest }) => rest) };
  await serving(withoutContent, async (requested) => {
    const result = await fetchGreenhouse('anthropic');
    assert.equal(requested[0], 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs');
    assert.equal(result.data!.jobs[0]!.descriptionText, null);
  });
});

test('fetchGreenhouse survives a job with no departments or location', async () => {
  const sparse = {
    jobs: [{ id: 1, title: 'Mystery Role', absolute_url: 'https://x.test/1' }],
  };
  await serving(sparse, async () => {
    const job = (await fetchGreenhouse('x')).data!.jobs[0]!;
    assert.equal(job.department, null);
    assert.equal(job.location, null);
    assert.equal(job.publishedAt, null);
    assert.equal(job.updatedAt, null);
    assert.equal(job.descriptionText, null);
  });
});

test('fetchGreenhouse url-encodes the board token', async () => {
  await serving({ jobs: [] }, async (requested) => {
    await fetchGreenhouse('acme corp/x');
    assert.equal(requested[0], 'https://boards-api.greenhouse.io/v1/boards/acme%20corp%2Fx/jobs');
  });
});

test('fetchGreenhouse reports an unexpected shape rather than returning empty jobs', async () => {
  await serving({ error: 'nope' }, async () => {
    const result = await fetchGreenhouse('acme');
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.error, 'unexpected shape');
  });
  await serving('<html>404</html>', async () => {
    const result = await fetchGreenhouse('acme');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unexpected shape');
  });
});

test('fetchGreenhouse propagates a 404 as a clean negative', async () => {
  await serving({}, async () => {
    const result = await fetchGreenhouse('not-a-customer');
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 404);
    assert.equal(result.data, null);
  }, 404);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ashby
// ─────────────────────────────────────────────────────────────────────────────

test('ashby fixture still has the shape the adapter reads', () => {
  assert.ok(Array.isArray(ashbyFixture.jobs));
  assert.ok(ashbyFixture.jobs.length >= 3);
  for (const j of ashbyFixture.jobs) {
    assert.equal(typeof j.id, 'string');
    assert.equal(typeof j.title, 'string');
    assert.equal(typeof j.jobUrl, 'string');
    assert.equal(typeof j.publishedAt, 'string');
    assert.equal(typeof j.isRemote, 'boolean');
    assert.equal(typeof j.isListed, 'boolean');
    assert.equal(typeof j.descriptionPlain, 'string');
    assert.equal(typeof j.compensation.scrapeableCompensationSalarySummary, 'string');
    assert.equal(typeof j.compensation.compensationTierSummary, 'string');
  }
});

test('fetchAshby maps descriptionPlain, compensation, publishedAt and isRemote', async () => {
  await serving(ashbyFixture, async (requested) => {
    const result = await fetchAshby('ramp');
    assert.equal(
      requested[0],
      'https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true',
    );

    const board = result.data!;
    assert.equal(board.platform, 'ashby');
    assert.equal(board.token, 'ramp');
    assert.equal(board.jobs.length, 4);

    const job = board.jobs[0]!;
    assert.equal(job.externalId, '34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    // The live payload carries a leading space in this title.
    assert.equal(job.title, 'Security Engineer, Cloud');
    assert.equal(job.department, 'Engineering');
    assert.equal(job.team, 'Backend');
    assert.equal(job.location, 'New York, NY (HQ)');
    assert.equal(job.isRemote, true);
    assert.equal(job.employmentType, 'FullTime');
    assert.equal(job.url, 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    assert.equal(job.publishedAt, '2026-04-07T17:12:35.753+00:00');
    assert.ok(job.descriptionText!.startsWith('ABOUT RAMP'));
    // descriptionPlain is already plain text — it must be passed through, not stripped.
    assert.equal(job.descriptionText, ashbyFixture.jobs[0]!.descriptionPlain);

    // "$211.4K - $290.6K" -> annual dollars.
    assert.equal(job.compMin, 211_400);
    assert.equal(job.compMax, 290_600);
  });
});

test('fetchAshby reads isRemote:false rather than defaulting it to true', async () => {
  await serving(ashbyFixture, async () => {
    const board = (await fetchAshby('ramp')).data!;
    const onsite = board.jobs.find((j) => j.title === 'Office Coordinator, NYC')!;
    assert.equal(onsite.isRemote, false);
    assert.equal(onsite.compMin, 80_000);
    assert.equal(onsite.compMax, 110_000);
  });
});

test('fetchAshby parses a tier summary carrying equity and commission', async () => {
  await serving(ashbyFixture, async () => {
    const board = (await fetchAshby('ramp')).data!;
    const pdr = board.jobs.find((j) => j.title.startsWith('Partner Development'))!;
    // Source string: "$110K – $120K • Offers Equity • Offers Commission • Total OTE with 70/30 split"
    assert.equal(pdr.compMin, 110_000);
    assert.equal(pdr.compMax, 120_000);
  });
});

test('fetchAshby excludes isListed:false postings', async () => {
  const payload = clone(ashbyFixture) as { jobs: { isListed?: boolean; title: string }[] };
  payload.jobs[1]!.isListed = false;

  await serving(payload, async () => {
    const board = (await fetchAshby('ramp')).data!;
    assert.equal(board.jobs.length, 3);
    assert.ok(
      !board.jobs.some((j) => j.title === 'Office Coordinator, NYC'),
      'an unlisted posting must never reach the pipeline',
    );
  });

  // A missing isListed is treated as listed — only an explicit false excludes.
  const missing = clone(ashbyFixture) as { jobs: { isListed?: boolean }[] };
  delete missing.jobs[1]!.isListed;
  await serving(missing, async () => {
    assert.equal((await fetchAshby('ramp')).data!.jobs.length, 4);
  });
});

test('fetchAshby falls back to compensationTierSummary and yields null when neither parses', async () => {
  const payload = clone(ashbyFixture) as {
    jobs: { compensation: { scrapeableCompensationSalarySummary: string | null; compensationTierSummary: string | null } | null }[];
  };
  payload.jobs[0]!.compensation!.scrapeableCompensationSalarySummary = null;
  payload.jobs[1]!.compensation = null;
  payload.jobs[2]!.compensation!.scrapeableCompensationSalarySummary = 'Offers Equity';
  payload.jobs[2]!.compensation!.compensationTierSummary = 'Offers Equity';

  await serving(payload, async () => {
    const jobs = (await fetchAshby('ramp')).data!.jobs;
    // Falls back to "$211.4K – $290.6K • Offers Equity".
    assert.equal(jobs[0]!.compMin, 211_400);
    assert.equal(jobs[0]!.compMax, 290_600);
    assert.equal(jobs[1]!.compMin, null);
    assert.equal(jobs[1]!.compMax, null);
    assert.equal(jobs[2]!.compMin, null);
    assert.equal(jobs[2]!.compMax, null);
  });
});

test('fetchAshby reports an unexpected shape rather than an empty board', async () => {
  await serving({ results: [] }, async () => {
    const result = await fetchAshby('ramp');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unexpected shape');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lever
// ─────────────────────────────────────────────────────────────────────────────

test('lever fixture still has the shape the adapter reads', () => {
  assert.ok(Array.isArray(leverFixture));
  assert.ok(leverFixture.length >= 3);
  for (const j of leverFixture) {
    assert.equal(typeof j.id, 'string');
    assert.equal(typeof j.text, 'string');
    assert.equal(typeof j.hostedUrl, 'string');
    assert.equal(typeof j.createdAt, 'number');
    assert.equal(typeof j.categories.team, 'string');
    assert.equal(typeof j.categories.location, 'string');
  }
  const paid = leverFixture.find((j) => 'salaryRange' in j && j.salaryRange)!;
  assert.ok(paid, 'fixture must retain at least one salaryRange');
  assert.equal((paid as { salaryRange: { interval: string } }).salaryRange.interval, 'per-year-salary');
});

test('fetchLever maps categories, workplaceType and the annual salary range', async () => {
  await serving(leverFixture, async (requested) => {
    const result = await fetchLever('people-ai');
    assert.equal(requested[0], 'https://api.lever.co/v0/postings/people-ai?mode=json');

    const board = result.data!;
    assert.equal(board.platform, 'lever');
    assert.equal(board.token, 'people-ai');
    assert.equal(board.jobs.length, leverFixture.length);

    const job = board.jobs[0]!;
    assert.equal(job.externalId, 'd6d4ddcc-1d05-433f-8777-e803665e219a');
    assert.equal(job.title, 'Director of IT');
    assert.equal(job.team, 'G&A');
    assert.equal(job.location, 'United States');
    assert.equal(job.employmentType, 'Full-Time');
    assert.equal(job.isRemote, true);
    assert.equal(job.url, 'https://jobs.lever.co/people-ai/d6d4ddcc-1d05-433f-8777-e803665e219a');
    assert.equal(job.compMin, 200_000);
    assert.equal(job.compMax, 270_000);
    assert.ok(job.descriptionText!.startsWith('About Backstory'));
  });
});

test('fetchLever converts createdAt epoch milliseconds to ISO, as a number or a string', async () => {
  await serving(leverFixture, async () => {
    const job = (await fetchLever('people-ai')).data!.jobs[0]!;
    assert.equal(job.publishedAt, new Date(1777410676083).toISOString());
    assert.equal(job.publishedAt, '2026-04-28T21:11:16.083Z');
  });

  // Lever has served createdAt as a string in the past; both must land on the
  // same ISO instant or reqs would appear to be republished on every sweep.
  const asString = clone(leverFixture).map((j) => ({ ...j, createdAt: String(j.createdAt) }));
  await serving(asString, async () => {
    const job = (await fetchLever('people-ai')).data!.jobs[0]!;
    assert.equal(job.publishedAt, '2026-04-28T21:11:16.083Z');
  });
});

test('fetchLever returns null publishedAt for missing or nonsensical createdAt', async () => {
  const payload = clone(leverFixture) as { createdAt?: unknown }[];
  delete payload[0]!.createdAt;
  payload[1]!.createdAt = 0;
  payload[2]!.createdAt = 'not-a-date';

  await serving(payload, async () => {
    const jobs = (await fetchLever('people-ai')).data!.jobs;
    assert.equal(jobs[0]!.publishedAt, null);
    assert.equal(jobs[1]!.publishedAt, null);
    assert.equal(jobs[2]!.publishedAt, null);
  });
});

test('fetchLever trusts ONLY per-year-salary intervals for comp', async () => {
  const hourly = clone(leverFixture) as { salaryRange?: { min: number; max: number; currency: string; interval: string } }[];
  hourly[0]!.salaryRange = { min: 60, max: 90, currency: 'USD', interval: 'per-hour-wage' };
  hourly[1]!.salaryRange = { min: 8_000, max: 12_000, currency: 'USD', interval: 'per-month-salary' };

  await serving(hourly, async () => {
    const jobs = (await fetchLever('people-ai')).data!.jobs;
    // An hourly rate treated as annual would produce a $22 fee estimate and
    // sink an otherwise strong company to the bottom of the ranking.
    assert.equal(jobs[0]!.compMin, null);
    assert.equal(jobs[0]!.compMax, null);
    assert.equal(jobs[1]!.compMin, null);
    assert.equal(jobs[1]!.compMax, null);
  });
});

test('fetchLever leaves comp null when the posting has no salaryRange', async () => {
  await serving(leverFixture, async () => {
    const jobs = (await fetchLever('people-ai')).data!.jobs;
    const noRange = jobs.find((j) => j.title === 'Principal Customer Success Manager')!;
    assert.equal(noRange.compMin, null);
    assert.equal(noRange.compMax, null);
    assert.equal(noRange.team, 'Customer Success');
    assert.equal(noRange.location, 'Remote');
  });
});

test('fetchLever marks non-remote workplaceType as isRemote false', async () => {
  const payload = clone(leverFixture) as { workplaceType?: string | null }[];
  payload[0]!.workplaceType = 'onsite';
  payload[1]!.workplaceType = null;
  await serving(payload, async () => {
    const jobs = (await fetchLever('people-ai')).data!.jobs;
    assert.equal(jobs[0]!.isRemote, false);
    assert.equal(jobs[1]!.isRemote, false);
  });
});

test('fetchLever rejects a non-array body as an unexpected shape', async () => {
  await serving({ postings: [] }, async () => {
    const result = await fetchLever('people-ai');
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.error, 'unexpected shape');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseCompRange — a wrong number here corrupts the fee estimate and the ranking
// ─────────────────────────────────────────────────────────────────────────────

test('parseCompRange handles the K-suffixed Ashby form', () => {
  assert.deepEqual(parseCompRange('$211.4K - $290.6K'), { min: 211_400, max: 290_600 });
  assert.deepEqual(parseCompRange('$189K – $330K • Offers Equity'), { min: 189_000, max: 330_000 });
  assert.deepEqual(parseCompRange('$80k - $110k'), { min: 80_000, max: 110_000 });
  assert.deepEqual(parseCompRange('$ 150 K - $ 200 K'), { min: 150_000, max: 200_000 });
});

test('parseCompRange handles fully written-out ranges with either dash', () => {
  assert.deepEqual(parseCompRange('$180,000 — $240,000'), { min: 180_000, max: 240_000 });
  assert.deepEqual(parseCompRange('$180,000 - $240,000'), { min: 180_000, max: 240_000 });
  assert.deepEqual(parseCompRange('$180,000 to $240,000 per year'), { min: 180_000, max: 240_000 });
});

test('parseCompRange handles millions', () => {
  assert.deepEqual(parseCompRange('$1M - $1.5M'), { min: 1_000_000, max: 1_500_000 });
});

test('parseCompRange returns null for equity-only strings', () => {
  assert.equal(parseCompRange('Offers Equity'), null);
  assert.equal(parseCompRange('0.1% – 0.5% equity'), null);
  assert.equal(parseCompRange('Competitive salary and meaningful equity'), null);
});

test('parseCompRange returns null for hourly rates', () => {
  assert.equal(parseCompRange('$50 - $75 / hour'), null);
  assert.equal(parseCompRange('$25.50 - $32.00 per hour'), null);
  assert.equal(parseCompRange('$1,200 - $1,800 per week'), null);
});

test('parseCompRange returns null for a single number', () => {
  assert.equal(parseCompRange('$180,000'), null);
  assert.equal(parseCompRange('$220K'), null);
  assert.equal(parseCompRange('Base salary: $150,000 DOE'), null);
});

test('parseCompRange returns null for malformed or absent input', () => {
  assert.equal(parseCompRange(null), null);
  assert.equal(parseCompRange(''), null);
  assert.equal(parseCompRange('   '), null);
  assert.equal(parseCompRange('TBD'), null);
  assert.equal(parseCompRange('$$'), null);
  assert.equal(parseCompRange('USD 180000 - 240000'), null, 'no $ sigil means no confident parse');
});

test('parseCompRange refuses implausible ranges rather than guessing', () => {
  // Inverted: almost always two unrelated figures picked up in the wrong order.
  assert.equal(parseCompRange('$300,000 - $100,000'), null);
  // Above the sane annual ceiling: usually a total-package or multi-year number.
  assert.equal(parseCompRange('$1.5M - $2.5M'), null);
  // Boundaries are inclusive.
  assert.deepEqual(parseCompRange('$20,000 - $30,000'), { min: 20_000, max: 30_000 });
  assert.deepEqual(parseCompRange('$100,000 - $2,000,000'), { min: 100_000, max: 2_000_000 });
});

test('parseCompRange only ever reads the first two dollar figures', () => {
  assert.deepEqual(
    parseCompRange('$180K – $240K • Offers Equity • $10K signing bonus'),
    { min: 180_000, max: 240_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe order
// ─────────────────────────────────────────────────────────────────────────────

test('PROBE_ORDER leads with the measured highest-hit-rate platform and has no duplicates', () => {
  assert.equal(PROBE_ORDER[0], 'ashby');
  assert.equal(PROBE_ORDER[1], 'greenhouse');
  assert.equal(new Set(PROBE_ORDER).size, PROBE_ORDER.length);
  assert.ok(!PROBE_ORDER.includes('workday' as never), 'workday needs a tenant+site, not a token');
});
