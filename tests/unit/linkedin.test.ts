/**
 * LinkedIn session + extraction — the parts provable without a browser.
 *
 * Three promises are pinned here, because each one failed silently once:
 *
 *   1. When the People-tab DOM harvest fails, the answer is null. There used
 *      to be a Voyager blended-search fallback with no company facet, which
 *      attributed GLOBAL search results — strangers — to the company being
 *      scored, and from there to the contact table. The page-runner fake below
 *      deliberately answers any Voyager search with a plausible stranger, so
 *      if that fallback ever comes back these tests fail loudly instead of
 *      quietly passing on a null body.
 *   2. Logout does not clear the daily halt. "No retry path around a stop"
 *      has to include the sign-out button.
 *   3. The 8-25s pacing sleep can cross local midnight; the budget write must
 *      land on the day the request actually leaves, not the day it queued.
 *
 * The electron stub is imported first — see tests/e2e/electron-stub.ts for why
 * import order is load-bearing. Everything else is real: real SQLite file,
 * real migration, the module's own persistence.
 */

import { installElectronStub, makeFakeWindow } from '../e2e/electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, get, run, type Db } from '../../src/main/db/index.js';
import {
  LINKEDIN_PARTITION,
  acquireRequestSlot,
  clearHalt,
  getStatus,
  haltForToday,
  localDay,
  logout,
  __setNowForTests,
} from '../../src/main/linkedin/session.js';
import {
  countRecruiters,
  findDecisionMakers,
  __setSpaSettleTimeoutForTests,
} from '../../src/main/linkedin/extract.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes: partition session + in-page script runner
// ─────────────────────────────────────────────────────────────────────────────

const stub = installElectronStub();

/**
 * The stub's shared fake session lacks the two webRequest hooks installGuards()
 * uses and the cookie jar isLoggedIn() reads. Patch them here rather than in
 * the stub: only this suite needs a logged-in-looking LinkedIn partition.
 */
const ses = stub.session.fromPartition(LINKEDIN_PARTITION) as unknown as {
  cookies: { get: (filter: { name?: string }) => Promise<unknown[]> };
  webRequest: Record<string, unknown>;
  clearCache?: () => Promise<void>;
};
ses.webRequest.onCompleted = () => undefined;
ses.webRequest.onBeforeRedirect = () => undefined;
ses.clearCache = async () => undefined;

let cookieJar: { name: string; value: string }[] = [];
ses.cookies.get = async (filter: { name?: string }) =>
  cookieJar.filter((c) => !filter?.name || c.name === filter.name);

/**
 * extract.ts runs every in-page operation through webContents.executeJavaScript
 * on its hidden worker window. The stub's FakeWebContents keeps that method on
 * the prototype, so overriding it there is the page-runner seam: each script is
 * recorded, then answered by kind.
 *
 * The Voyager branch is a trap, not a convenience. If the unscoped search
 * fallback is ever reintroduced, it will "succeed" here with a stranger whose
 * headline says Recruiter — and the assertions that the result is null and
 * that only one budget unit was spent will both fail.
 */
const wcProto = Object.getPrototypeOf(makeFakeWindow().webContents) as {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
};
const executedScripts: string[] = [];
let domHarvest: unknown = null;

wcProto.executeJavaScript = async (code: string) => {
  executedScripts.push(code);
  if (code.includes('scrollTo')) throw new Error('scrolling disabled in tests');
  if (code.includes('csrf-token')) {
    return {
      status: 200,
      url: 'https://www.linkedin.com/voyager/api/search/blended',
      body: JSON.stringify({
        included: [
          {
            publicIdentifier: 'total-stranger',
            firstName: 'Total',
            lastName: 'Stranger',
            headline: 'Recruiter at Some Other Company',
          },
        ],
      }),
    };
  }
  if (code.includes('querySelectorAll')) return domHarvest;
  return null;
};

function voyagerSearches(): string[] {
  return executedScripts.filter((s) => s.includes('voyager/api/search') || s.includes('csrf-token'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Real persistence
// ─────────────────────────────────────────────────────────────────────────────

let tmpRoot: string;
let db: Db;

function putSetting(key: string, value: string): void {
  run(
    db,
    `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    Date.now(),
  );
}

function seedBudget(day: string, rec: { used: number; lastRequestAt: number }): void {
  putSetting(`linkedin.budget.${day}`, JSON.stringify(rec));
}

function readBudgetRow(day: string): { used: number; lastRequestAt: number } | null {
  const row = get<{ value: string }>(
    db,
    'SELECT value FROM setting WHERE key = ?',
    `linkedin.budget.${day}`,
  );
  return row ? (JSON.parse(row.value) as { used: number; lastRequestAt: number }) : null;
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-linkedin-'));
  db = initDb(path.join(tmpRoot, 'linkedin.db'));
  putSetting('crawl.linkedinEnabled', 'true');
  // 00:00-24:00 so the suite is inside the active window whenever it runs.
  putSetting('crawl.linkedinWindowStart', '00:00');
  putSetting('crawl.linkedinWindowEnd', '24:00');
  cookieJar = [
    { name: 'li_at', value: 'test-li-at' },
    { name: 'JSESSIONID', value: '"ajax:1234567890"' },
  ];
});

after(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const COMPANY_URL = 'https://www.linkedin.com/company/acme/';
const PEOPLE_URL = 'https://www.linkedin.com/company/acme/people/';

// ─────────────────────────────────────────────────────────────────────────────
// Extraction: DOM-failure discipline
// ─────────────────────────────────────────────────────────────────────────────

describe('linkedin extraction — the DOM harvest is the only source of company-scoped people', () => {
  test('a successful DOM harvest counts recruiters from the People tab', async () => {
    seedBudget(localDay(), { used: 0, lastRequestAt: 0 });
    executedScripts.length = 0;
    domHarvest = {
      people: [
        {
          id: 'jane-doe',
          href: 'https://www.linkedin.com/in/jane-doe',
          text: 'Jane Doe\nTechnical Recruiter',
        },
        {
          id: 'bob-smith',
          href: 'https://www.linkedin.com/in/bob-smith',
          text: 'Bob Smith\nSoftware Engineer',
        },
      ],
      bodyText: 'Acme\n11-50 employees\nSoftware Development',
      url: PEOPLE_URL,
      title: 'Acme | LinkedIn',
      empty: false,
    };

    const signal = await countRecruiters(COMPANY_URL);
    assert.ok(signal, 'a rendered People tab with cards is a conclusive answer');
    assert.equal(signal.method, 'dom');
    assert.equal(signal.recruiterCount, 1);
    assert.equal(signal.hasInhouseTa, true);
    assert.equal(signal.scanned, 2);
    assert.equal(signal.headcountRange, '11-50 employees');
    assert.match(signal.sourceUrl, /\/company\/acme\/people\//);
    assert.deepEqual(voyagerSearches(), [], 'the DOM route must never touch Voyager search');
    assert.equal(readBudgetRow(localDay())?.used, 1, 'one navigation, one budget unit');
  });

  test('a DOM harvest that never settles returns null — no unscoped search fallback', async () => {
    seedBudget(localDay(), { used: 0, lastRequestAt: 0 });
    executedScripts.length = 0;
    domHarvest = null;
    __setSpaSettleTimeoutForTests(0); // the SPA never produces cards
    try {
      const signal = await countRecruiters(COMPANY_URL);
      assert.equal(
        signal,
        null,
        'an inconclusive harvest must stay inconclusive — the fake Voyager stranger must not become a recruiter signal',
      );
      assert.deepEqual(
        voyagerSearches(),
        [],
        'no fallback search may run: its results are global, and attributing them to the company fabricates data',
      );
      assert.equal(
        readBudgetRow(localDay())?.used,
        1,
        'only the navigation slot is spent — the removed fallback used to burn a second unit',
      );
    } finally {
      __setSpaSettleTimeoutForTests(null);
    }
  });

  test('a page that renders but yields no cards is also inconclusive', async () => {
    seedBudget(localDay(), { used: 0, lastRequestAt: 0 });
    executedScripts.length = 0;
    domHarvest = {
      people: [],
      bodyText: 'Something rendered, but no profile cards did',
      url: PEOPLE_URL,
      title: 'Acme | LinkedIn',
      empty: false,
    };
    __setSpaSettleTimeoutForTests(200); // one poll, then give up
    try {
      const signal = await countRecruiters(COMPANY_URL);
      assert.equal(signal, null);
      assert.deepEqual(voyagerSearches(), []);
      assert.equal(readBudgetRow(localDay())?.used, 1);
    } finally {
      __setSpaSettleTimeoutForTests(null);
    }
  });

  test('an explicit "no results" page is still refused as a recruiter count', async () => {
    seedBudget(localDay(), { used: 0, lastRequestAt: 0 });
    executedScripts.length = 0;
    domHarvest = {
      people: [],
      bodyText: 'No results found',
      url: PEOPLE_URL,
      title: 'Acme | LinkedIn',
      empty: true,
    };
    const signal = await countRecruiters(COMPANY_URL);
    // Zero profiles under a keyword filter is an answer about the filter, not
    // proof the company has no recruiters — score.ts awards full points for a
    // confirmed zero, so an unsure zero must surface as null.
    assert.equal(signal, null);
    assert.deepEqual(voyagerSearches(), []);
  });

  test('findDecisionMakers on a failed harvest returns null and stores no one', async () => {
    seedBudget(localDay(), { used: 0, lastRequestAt: 0 });
    executedScripts.length = 0;
    domHarvest = null;
    __setSpaSettleTimeoutForTests(0);
    try {
      const people = await findDecisionMakers(COMPANY_URL);
      assert.equal(people, null, 'no harvest, no decision makers — never strangers from a global search');
      assert.deepEqual(voyagerSearches(), []);
      assert.equal(readBudgetRow(localDay())?.used, 1, 'the first failed query breaks the loop');
    } finally {
      __setSpaSettleTimeoutForTests(null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session: budget-day accounting
// ─────────────────────────────────────────────────────────────────────────────

describe('linkedin session — the budget write lands on the day the request leaves', () => {
  test('a same-day request increments the same day', async () => {
    const today = localDay();
    seedBudget(today, { used: 3, lastRequestAt: 0 });
    const slot = await acquireRequestSlot(1);
    assert.equal(slot.ok, true);
    const rec = readBudgetRow(today);
    assert.equal(rec?.used, 4);
    assert.ok((rec?.lastRequestAt ?? 0) > 0);
  });

  test('a pacing sleep that crosses midnight books the request to the new day', async () => {
    const base = new Date();
    const preMidnight = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 300);
    const postMidnight = new Date(preMidnight.getTime() + 900);
    const oldDay = localDay(preMidnight);
    const newDay = localDay(postMidnight);
    assert.notEqual(oldDay, newDay, 'the two clock readings must straddle midnight');

    // Derive the minimum request gap from the status surface instead of
    // hard-coding the constant: nextRequestNotBefore = lastRequestAt + gap.
    seedBudget(oldDay, { used: 7, lastRequestAt: 1_000_000 });
    const gapMin = ((await getStatus()).nextRequestNotBefore ?? 0) - 1_000_000;
    assert.ok(gapMin > 0);

    let clock = preMidnight.getTime();
    __setNowForTests(() => clock);
    const realRandom = Math.random;
    Math.random = () => 0; // pin the randomised gap to its minimum
    try {
      // The previous request was gap-minus-700ms ago, so the gate sleeps ~700ms
      // — and midnight falls inside that sleep.
      const seededLast = clock - gapMin + 700;
      seedBudget(oldDay, { used: 7, lastRequestAt: seededLast });

      const pending = acquireRequestSlot(1);
      await delay(150);
      clock = postMidnight.getTime(); // midnight passes while the gate sleeps
      const slot = await pending;

      assert.equal(slot.ok, true);
      assert.deepEqual(
        readBudgetRow(newDay),
        { used: 1, lastRequestAt: postMidnight.getTime() },
        'the new day starts from its own count of one, not from yesterday plus one',
      );
      assert.deepEqual(
        readBudgetRow(oldDay),
        { used: 7, lastRequestAt: seededLast },
        "yesterday's record is closed out untouched",
      );
    } finally {
      Math.random = realRandom;
      __setNowForTests(null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session: logout does not open a retry path
// ─────────────────────────────────────────────────────────────────────────────

describe('linkedin session — logout preserves the day-stop', () => {
  test('a halt survives logout, in memory and in the setting table', async () => {
    const today = localDay();
    seedBudget(today, { used: 9, lastRequestAt: 0 });
    await haltForToday('LinkedIn returned 429 (rate limited)', 'blocked');
    assert.equal((await getStatus()).state, 'blocked');

    await logout();

    const status = await getStatus();
    assert.equal(status.state, 'blocked', 'sign-out must not be a retry path around a day-stop');
    assert.equal(status.haltReason, 'LinkedIn returned 429 (rate limited)');

    const row = get<{ value: string }>(
      db,
      'SELECT value FROM setting WHERE key = ?',
      'linkedin.halt',
    );
    assert.ok(row, 'the persisted halt row must survive logout');
    assert.equal((JSON.parse(row.value) as { day: string }).day, today);

    assert.equal(
      readBudgetRow(today)?.used,
      9,
      "the day's budget bookkeeping survives logout too",
    );

    await clearHalt(); // leave the module clean for whoever runs next
  });
});
