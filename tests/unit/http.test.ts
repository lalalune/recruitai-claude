/**
 * HTTP client + bounded-concurrency map.
 *
 * No network: `globalThis.fetch` is replaced for the duration of each test.
 * The properties under test are the ones that fail silently in production —
 * a concurrency limit that doesn't actually limit, a result array that gets
 * reordered, or a thrown task that takes down the whole sweep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BlockedError,
  USER_AGENT,
  httpJson,
  httpRequest,
  mapLimit,
} from '../../src/main/util/http.js';

// ─────────────────────────────────────────────────────────────────────────────
// fetch stubbing
// ─────────────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Swaps in a fake fetch, runs `body`, and always restores the real one — a
 * leaked stub would make every later test in the same process silently fake.
 */
async function withFetch<T>(
  handler: (call: FetchCall, attempt: number) => Response | Promise<Response> | never,
  body: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof globalThis.fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// ─────────────────────────────────────────────────────────────────────────────
// httpRequest
// ─────────────────────────────────────────────────────────────────────────────

test('httpRequest returns the body and echoes request metadata', async () => {
  await withFetch(
    () => new Response('hello', { status: 200 }),
    async (calls) => {
      const res = await httpRequest('https://example.test/a');
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      assert.equal(res.body, 'hello');
      assert.equal(res.url, 'https://example.test/a');
      assert.equal(res.blocked, undefined);
      assert.ok(!Number.isNaN(Date.parse(res.fetchedAt)), 'fetchedAt must be an ISO timestamp');
      assert.equal(calls.length, 1);
    },
  );
});

test('httpRequest sends a truthful User-Agent carrying a contact URL', async () => {
  await withFetch(
    () => new Response('ok'),
    async (calls) => {
      await httpRequest('https://example.test/a');
      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers['User-Agent'], USER_AGENT);
      assert.match(USER_AGENT, /https?:\/\//, 'UA must carry a reachable contact URL');
    },
  );
});

test('httpRequest merges caller headers over the defaults', async () => {
  await withFetch(
    () => new Response('ok'),
    async (calls) => {
      await httpRequest('https://example.test/a', { headers: { Accept: 'text/html', 'X-Test': '1' } });
      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers.Accept, 'text/html');
      assert.equal(headers['X-Test'], '1');
      assert.equal(headers['User-Agent'], USER_AGENT);
    },
  );
});

test('httpRequest treats a 404 as a normal, non-blocked negative', async () => {
  await withFetch(
    () => new Response('not found', { status: 404 }),
    async (calls) => {
      const res = await httpRequest('https://example.test/missing');
      assert.equal(res.ok, false);
      assert.equal(res.status, 404);
      assert.equal(res.blocked, undefined);
      assert.equal(calls.length, 1, 'a 404 must not be retried — it is the ATS enumeration signal');
    },
  );
});

for (const status of [429, 403]) {
  test(`httpRequest stops immediately on ${status} and never retries or evades`, async () => {
    await withFetch(
      () => new Response('go away', { status }),
      async (calls) => {
        const res = await httpRequest('https://example.test/blocked', { maxRetries: 5 });
        assert.equal(res.ok, false);
        assert.equal(res.status, status);
        assert.equal(res.blocked, true);
        assert.equal(res.body, '');
        assert.match(res.error ?? '', new RegExp(String(status)));
        assert.equal(calls.length, 1, 'a deliberate block must produce exactly one request');
      },
    );
  });
}

test('httpRequest retries a 5xx up to maxRetries and stays inside the backoff ceiling', async () => {
  await withFetch(
    () => new Response('boom', { status: 503 }),
    async (calls) => {
      const started = Date.now();
      const res = await httpRequest('https://example.test/flaky', { maxRetries: 2 });
      const elapsed = Date.now() - started;

      assert.equal(calls.length, 3, 'initial attempt + 2 retries');
      assert.equal(res.ok, false);
      assert.equal(res.status, 503);
      // Full jitter: attempt 0 sleeps <1000ms, attempt 1 <2000ms. The ceiling is
      // what keeps a flapping host from stalling an entire sweep.
      assert.ok(elapsed < 3_400, `backoff must be bounded, took ${elapsed}ms`);
    },
  );
});

test('httpRequest does not retry a 5xx when maxRetries is 0', async () => {
  await withFetch(
    () => new Response('boom', { status: 500 }),
    async (calls) => {
      const res = await httpRequest('https://example.test/flaky', { maxRetries: 0 });
      assert.equal(calls.length, 1);
      assert.equal(res.status, 500);
      assert.equal(res.ok, false);
    },
  );
});

test('httpRequest recovers when a retried attempt succeeds', async () => {
  await withFetch(
    (_call, attempt) => (attempt === 0 ? new Response('boom', { status: 502 }) : new Response('good')),
    async (calls) => {
      const res = await httpRequest('https://example.test/flaky', { maxRetries: 2 });
      assert.equal(calls.length, 2);
      assert.equal(res.ok, true);
      assert.equal(res.body, 'good');
    },
  );
});

test('httpRequest converts a transport failure into a status-0 result rather than throwing', async () => {
  await withFetch(
    () => {
      throw new Error('ECONNRESET');
    },
    async (calls) => {
      const res = await httpRequest('https://example.test/down', { maxRetries: 1 });
      assert.equal(calls.length, 2);
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.equal(res.body, '');
      assert.equal(res.error, 'ECONNRESET');
    },
  );
});

test('httpRequest caps the response size instead of buffering an unbounded body', async () => {
  await withFetch(
    () => new Response('x'.repeat(50_000)),
    async () => {
      const res = await httpRequest('https://example.test/huge', { maxBytes: 1_000, maxRetries: 0 });
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.match(res.error ?? '', /exceeded 1000 bytes/);
    },
  );
});

test('httpRequest passes a body through on POST', async () => {
  await withFetch(
    () => new Response('ok'),
    async (calls) => {
      await httpRequest('https://example.test/p', { method: 'POST', body: '{"a":1}' });
      assert.equal(calls[0]!.init.method, 'POST');
      assert.equal(calls[0]!.init.body, '{"a":1}');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// httpJson
// ─────────────────────────────────────────────────────────────────────────────

test('httpJson parses a successful JSON response', async () => {
  await withFetch(
    () => json({ jobs: [{ id: 1 }] }),
    async () => {
      const data = await httpJson<{ jobs: { id: number }[] }>('https://example.test/j');
      assert.deepEqual(data, { jobs: [{ id: 1 }] });
    },
  );
});

test('httpJson returns null rather than throwing on malformed JSON', async () => {
  await withFetch(
    () => new Response('<html>maintenance</html>'),
    async () => {
      assert.equal(await httpJson('https://example.test/j'), null);
    },
  );
});

test('httpJson returns null for a non-2xx and for an empty body', async () => {
  await withFetch(
    () => new Response('{}', { status: 404 }),
    async () => {
      assert.equal(await httpJson('https://example.test/j'), null);
    },
  );
  await withFetch(
    () => new Response(''),
    async () => {
      assert.equal(await httpJson('https://example.test/j'), null);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// BlockedError
// ─────────────────────────────────────────────────────────────────────────────

test('BlockedError carries the url and status it was raised for', () => {
  const err = new BlockedError('https://example.test/x', 429);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'BlockedError');
  assert.equal(err.url, 'https://example.test/x');
  assert.equal(err.status, 429);
  assert.match(err.message, /429/);
  assert.match(err.message, /https:\/\/example\.test\/x/);
});

// ─────────────────────────────────────────────────────────────────────────────
// mapLimit
// ─────────────────────────────────────────────────────────────────────────────

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('mapLimit never exceeds the concurrency limit', async () => {
  for (const limit of [1, 3, 7]) {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);

    await mapLimit(
      items,
      limit,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(n % 3);
        inFlight--;
        return n;
      },
      { jitterMs: 0 },
    );

    assert.equal(inFlight, 0, 'every task must have settled');
    assert.ok(peak <= limit, `peak in-flight ${peak} exceeded limit ${limit}`);
    assert.equal(peak, limit, 'the limit should actually be saturated, not under-used');
  }
});

test('mapLimit preserves input order even when tasks finish out of order', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const out = await mapLimit(
    items,
    3,
    async (s, i) => {
      // Later items resolve first, so a naive push-based implementation would
      // return them reversed.
      await tick((items.length - i) * 4);
      return `${s}:${i}`;
    },
    { jitterMs: 0 },
  );
  assert.deepEqual(out, ['a:0', 'b:1', 'c:2', 'd:3', 'e:4', 'f:5']);
});

test('mapLimit converts a throwing task to null instead of rejecting', async () => {
  const out = await mapLimit(
    [0, 1, 2, 3],
    2,
    async (n) => {
      if (n === 2) throw new Error('one bad board must not kill the sweep');
      return n * 10;
    },
    { jitterMs: 0 },
  );
  assert.deepEqual(out, [0, 10, null, 30]);
});

test('mapLimit rejecting on every item still resolves with all nulls', async () => {
  const out = await mapLimit(
    [1, 2, 3],
    3,
    async () => {
      throw new Error('nope');
    },
    { jitterMs: 0 },
  );
  assert.deepEqual(out, [null, null, null]);
});

test('mapLimit handles an empty list and a limit larger than the list', async () => {
  assert.deepEqual(await mapLimit([], 10, async (x) => x, { jitterMs: 0 }), []);
  assert.deepEqual(await mapLimit([1, 2], 99, async (n) => n + 1, { jitterMs: 0 }), [2, 3]);
});

test('mapLimit reports progress exactly once per item, monotonically', async () => {
  const seen: number[] = [];
  const items = Array.from({ length: 12 }, (_, i) => i);
  await mapLimit(items, 4, async (n) => n, {
    jitterMs: 0,
    onProgress: (done, total) => {
      assert.equal(total, items.length);
      seen.push(done);
    },
  });
  assert.deepEqual(seen, items.map((i) => i + 1));
});

test('mapLimit jitter is bounded by jitterMs per task', async () => {
  const items = [1, 2, 3, 4, 5, 6];
  const started = Date.now();
  await mapLimit(items, 1, async (n) => n, { jitterMs: 40 });
  const elapsed = Date.now() - started;
  // Serial worker: at most jitterMs of sleep per item, plus scheduling slack.
  assert.ok(elapsed < items.length * 40 + 250, `jitter must be bounded, took ${elapsed}ms`);
});

test('mapLimit passes the true index to the task', async () => {
  const out = await mapLimit(['x', 'y', 'z'], 2, async (_s, i) => i, { jitterMs: 0 });
  assert.deepEqual(out, [0, 1, 2]);
});
