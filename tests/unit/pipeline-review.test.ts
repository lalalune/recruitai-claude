/**
 * Regressions for source-level defects that put WRONG data in the database.
 *
 * Each test here corresponds to a shape that was silently accepted before:
 * a truncated board reported as complete (which the req differ reads as a mass
 * close), a foreign-currency salary banked as dollars (which reorders the
 * queue), and a subdomain label used as an ATS token (which attributed one
 * company's requisitions to another).
 *
 * No network: `globalThis.fetch` is routed per-URL for the duration of a test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchLever, fetchSmartRecruiters, parseCompRange } from '../../src/main/sources/ats.js';
import { candidateTokens, registrableLabel } from '../../src/main/sources/seeds.js';

type Route = (url: string) => Response;

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

const srPage = (ids: string[], totalFound?: number) =>
  new Response(
    JSON.stringify({ content: ids.map((id) => ({ id, name: `Role ${id}` })), totalFound: totalFound ?? ids.length }),
    { status: 200 },
  );

// ─────────────────────────────────────────────────────────────────────────────
// SmartRecruiters pagination — a prefix reported as a whole board is a mass close
// ─────────────────────────────────────────────────────────────────────────────

test('a SmartRecruiters board truncated by the page cap is flagged partial', async () => {
  // 10 full pages: there is an eleventh we never asked for. Unflagged, the next
  // refresh closes every posting past 1000 and the one after re-opens them as
  // "reposts" — the exact signal the whole pitch is built on, fabricated.
  await withRoutes(
    (url) => {
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
      return srPage(Array.from({ length: 100 }, (_, i) => `p${offset + i}`), 5_000);
    },
    async (requested) => {
      const res = await fetchSmartRecruiters('megacorp');
      assert.ok(res.ok && res.data);
      assert.equal(res.data.jobs.length, 1000, 'the cap still bounds how much we fetch');
      assert.equal(res.data.partial, true, 'a board we only read a prefix of must never reach the differ');
      assert.equal(requested.length, 10);
    },
  );
});

test('a SmartRecruiters page that returns 200 with an unreadable body is flagged partial', async () => {
  // A 200 we cannot parse is indistinguishable from a page we never received.
  // Read as an empty page it ends the loop looking complete.
  await withRoutes(
    (url) =>
      url.includes('offset=0')
        ? srPage(Array.from({ length: 100 }, (_, i) => `p${i}`), 150)
        : new Response('<html>gateway error</html>', { status: 200 }),
    async () => {
      const res = await fetchSmartRecruiters('garbled');
      assert.ok(res.ok && res.data);
      assert.equal(res.data.jobs.length, 100, 'the page we did read is real data and is kept');
      assert.equal(res.data.partial, true);
    },
  );
});

test('a SmartRecruiters board that fits inside the cap is not flagged partial', async () => {
  await withRoutes(
    (url) =>
      url.includes('offset=0')
        ? srPage(Array.from({ length: 100 }, (_, i) => `p${i}`), 150)
        : srPage(Array.from({ length: 50 }, (_, i) => `p${100 + i}`), 150),
    async () => {
      const res = await fetchSmartRecruiters('normalco');
      assert.ok(res.ok && res.data);
      assert.equal(res.data.jobs.length, 150);
      assert.notEqual(res.data.partial, true, 'a complete board must still be able to close a vanished req');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Currency — a non-USD figure banked as dollars reorders the queue
// ─────────────────────────────────────────────────────────────────────────────

test('lever ignores a salary range that is not in USD', async () => {
  const posting = (id: string, currency: string) => ({
    id,
    text: 'Backend Engineer',
    hostedUrl: `https://jobs.lever.co/acme/${id}`,
    salaryRange: { min: 180_000, max: 240_000, currency, interval: 'per-year-salary' },
  });

  await withRoutes(
    () =>
      new Response(JSON.stringify([posting('usd', 'USD'), posting('cad', 'CAD'), posting('gbp', 'GBP')]), {
        status: 200,
      }),
    async () => {
      const res = await fetchLever('acme');
      assert.ok(res.ok && res.data);
      const by = (id: string) => res.data!.jobs.find((j) => j.externalId === id)!;

      assert.equal(by('usd').compMin, 180_000);
      assert.equal(by('usd').compMax, 240_000);
      // CAD 240k is ~USD 175k; banking it as dollars overstates the fee by a
      // third and moves the company up the queue past companies worth more.
      assert.equal(by('cad').compMin, null);
      assert.equal(by('cad').compMax, null);
      assert.equal(by('gbp').compMin, null);
    },
  );
});

test('parseCompRange refuses a dollar figure carrying a country prefix', () => {
  assert.equal(parseCompRange('CA$180,000 - CA$240,000'), null);
  assert.equal(parseCompRange('A$200K – A$260K'), null);
  assert.equal(parseCompRange('SGD$150,000 - SGD$190,000'), null);
  // US$ means exactly what the rest of the pipeline already assumes.
  assert.deepEqual(parseCompRange('US$180,000 - US$240,000'), { min: 180_000, max: 240_000 });
});

test('parseCompRange refuses a monthly range that clears the annual floor', () => {
  // $20k-$25k a month reads as a plausible junior annual salary; it is a
  // $270k-a-year role and a $81k fee, not a $6.7k one.
  assert.equal(parseCompRange('$20,000 - $25,000 per month'), null);
  assert.equal(parseCompRange('$22,000 – $28,000 monthly'), null);
  assert.equal(parseCompRange('$25,000 - $30,000 / month'), null);
});

test('parseCompRange still reads the ordinary annual forms', () => {
  assert.deepEqual(parseCompRange('$180,000 to $240,000 per year'), { min: 180_000, max: 240_000 });
  assert.deepEqual(parseCompRange('$180,000 - $240,000 annually'), { min: 180_000, max: 240_000 });
  assert.deepEqual(parseCompRange('$211.4K - $290.6K'), { min: 211_400, max: 290_600 });
  assert.deepEqual(parseCompRange('$189K – $330K • Offers Equity'), { min: 189_000, max: 330_000 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token derivation — a subdomain label is never the company's identity
// ─────────────────────────────────────────────────────────────────────────────

test('the ATS token from a website is the registrable label, not the first one', () => {
  // Measured in the dev database: MBX (http://us.memebox.com) probed the token
  // "us", resolved a stranger's Greenhouse board, and was scored on a
  // requisition whose every link pointed at itelinternational.com.
  assert.equal(registrableLabel('http://us.memebox.com'), 'memebox');
  assert.deepEqual(candidateTokens('MBX', 'http://us.memebox.com'), ['mbx', 'memebox']);

  assert.equal(registrableLabel('https://info.mathos.ai/'), 'mathos');
  assert.equal(registrableLabel('https://business.stayflexi.com/'), 'stayflexi');
  assert.equal(registrableLabel('https://inbox.tryresponse.com/'), 'tryresponse');
});

test('registrableLabel handles the multi-part suffixes and the shapes already relied on', () => {
  assert.equal(registrableLabel('https://careers.acme.co.uk/jobs'), 'acme');
  assert.equal(registrableLabel('https://acme.co.uk'), 'acme');
  assert.equal(registrableLabel('https://www.people.ai'), 'people');
  assert.equal(registrableLabel('https://ACME.io/careers'), 'acme');
  assert.equal(registrableLabel('http://www.acme-hq.com'), 'acme-hq');
  assert.equal(registrableLabel('https://acme.com:8443/careers'), 'acme');

  // Not a usable website: no protocol, or no dot to split on.
  assert.equal(registrableLabel('acme.com'), null);
  assert.equal(registrableLabel('https://localhost'), null);
});
