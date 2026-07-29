/**
 * Gmail module tests: MIME construction, Content-Type parsing, inbox
 * historyId resume semantics, and the connect flow's re-entrancy guard.
 *
 * The inbox tests exist because the resume logic only ever goes wrong against
 * a mailbox with more mail than one sync examines — a state no manual test
 * reaches. The faked client replays exactly the paged/truncated responses a
 * 500+-message backlog produces, and the assertions pin the invariant that a
 * persisted historyId never claims coverage of a message nobody examined.
 */

// Must come first: patches require('electron') before any app module is evaluated.
import { installElectronStub, openedExternally } from '../e2e/electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { gmail_v1 } from '@googleapis/gmail';
import { initDb, closeDb, getDb, prep } from '../../src/main/db/index.js';
import {
  SEND_ID_HEADER,
  buildRawMessage,
  headerValue,
  parseContentType,
  parseHeaderBlock,
} from '../../src/main/gmail/mime.js';
import { syncInbox } from '../../src/main/gmail/inbox.js';
import {
  KEY_CLIENT_ID,
  KEY_CLIENT_SECRET,
  KEY_HISTORY_ID,
  KEY_REFRESH_TOKEN,
  connectGmail,
  getSetting,
  setSecret,
  setSetting,
} from '../../src/main/gmail/oauth.js';

installElectronStub();

let tmpRoot = '';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-gmail-test-'));
  initDb(path.join(tmpRoot, 'gmail.db'));
  // The stub reports safeStorage unavailable, so this lands as marked plaintext
  // — which is the point: isConnected() must see a token through that path too.
  await setSecret(KEY_REFRESH_TOKEN, 'test-refresh-token');
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
// Golden MIME message
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail mime: buildRawMessage golden output', () => {
  const fixture = {
    from: 'Shaw Walters <shaw@example.com>',
    to: 'Ivana Řezníčková <ivana@example.cz>',
    subject: 'Nabídka spolupráce — recruiting pro váš tým',
    body:
      'Ahoj Ivano,\n\n' +
      'saw the three open reqs on your careers page and figured the fastest thing is to ask ' +
      'directly over café-length email rather than a calendar link — is hiring for the platform ' +
      'team something you want an outside hand with this quarter?\n\n— Shaw',
    sendId: '01JGOLDENSENDID0000000000',
    inReplyTo: '<prior-message@example.cz>',
    references: ['<prior-message@example.cz>'],
  };

  test('gmail golden message encodes, folds and round-trips correctly', async () => {
    const raw = await buildRawMessage(fixture);

    // users.messages.send wants unpadded base64url and nothing else.
    assert.match(raw, /^[A-Za-z0-9_-]+$/, 'raw is not clean base64url');

    const decoded = Buffer.from(raw, 'base64url').toString('utf8');

    // RFC 5322 wants CRLF line endings, with no bare CR or LF anywhere.
    for (const line of decoded.split('\r\n')) {
      assert.ok(!line.includes('\n') && !line.includes('\r'), `bare CR/LF in line: ${JSON.stringify(line)}`);
    }

    // The documented casing rule: nodemailer's own normaliser would emit
    // "X-Recruitai-Send-ID"; the composer overrides it back to ours.
    assert.ok(decoded.includes(`${SEND_ID_HEADER}: ${fixture.sendId}`), 'send-id header missing or re-cased');
    assert.ok(!decoded.includes('X-Recruitai-Send-ID'), 'nodemailer default casing leaked through');
    assert.equal(decoded.match(/X-RecruitAI-Send-Id/g)?.length, 1, 'send-id header must appear exactly once');

    // Non-ASCII subject becomes an RFC 2047 encoded word; the raw text must not
    // appear anywhere in the wire form.
    assert.match(decoded, /\r\nSubject: =\?UTF-8\?[BQ]\?/i, 'subject is not RFC 2047 encoded');
    assert.ok(!decoded.includes('Nabídka'), 'raw UTF-8 leaked into the subject line');

    // The recipient display name is encoded, but the address itself never is.
    assert.ok(decoded.includes('ivana@example.cz'));
    assert.ok(decoded.includes('From: Shaw Walters <shaw@example.com>'));

    // Body: quoted-printable, with the UTF-8 bytes escaped and the long
    // paragraph folded with soft line breaks.
    assert.ok(decoded.includes('Content-Transfer-Encoding: quoted-printable'));
    assert.ok(decoded.includes('=C3=A9'), 'é was not quoted-printable encoded');
    assert.ok(decoded.includes('=E2=80=94'), 'em dash was not quoted-printable encoded');
    assert.match(decoded, /=\r\n/, 'long body line was not folded with a soft break');

    // Round trip: the decoded bytes parse as headers + body with this
    // codebase's own inbound parser, and the threading headers survive.
    const split = decoded.indexOf('\r\n\r\n');
    assert.ok(split > 0, 'no blank line between headers and body');
    const headers = parseHeaderBlock(decoded.slice(0, split));

    assert.equal(headerValue(headers, 'x-recruitai-send-id'), fixture.sendId);
    assert.equal(headerValue(headers, 'In-Reply-To'), fixture.inReplyTo);
    assert.equal(headerValue(headers, 'References'), fixture.references[0]);
    assert.equal(headerValue(headers, 'MIME-Version'), '1.0');

    const ct = parseContentType(headerValue(headers, 'Content-Type'));
    assert.equal(ct.type, 'text/plain');
    assert.equal(ct.params.charset?.toLowerCase(), 'utf-8');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content-Type parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('gmail mime: parseContentType', () => {
  test('gmail parseContentType handles a plain parameter list', () => {
    const ct = parseContentType('multipart/report; report-type=delivery-status; boundary=abc123');
    assert.equal(ct.type, 'multipart/report');
    assert.equal(ct.params['report-type'], 'delivery-status');
    assert.equal(ct.params.boundary, 'abc123');
  });

  test('gmail parseContentType keeps a quoted boundary containing the delimiter intact', () => {
    const ct = parseContentType('multipart/mixed; boundary="a;b"; charset=utf-8');
    assert.equal(ct.type, 'multipart/mixed');
    assert.equal(ct.params.boundary, 'a;b', 'the ; inside the quoted value split the parameter');
    assert.equal(ct.params.charset, 'utf-8');

    // = and ; both legal inside quotes; parameters after the quoted one survive.
    const gnarly = parseContentType('multipart/report; boundary="=_Part;x=y"; report-type=delivery-status');
    assert.equal(gnarly.params.boundary, '=_Part;x=y');
    assert.equal(gnarly.params['report-type'], 'delivery-status');
  });

  test('gmail parseContentType tolerates null and empty input', () => {
    assert.deepEqual(parseContentType(null), { type: '', params: {} });
    assert.deepEqual(parseContentType(''), { type: '', params: {} });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inbox historyId resume semantics
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal but classifiable message: not a DSN, not SENT/DRAFT/CHAT. */
function fakeMessage(id: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.now()),
    labelIds: ['INBOX', 'UNREAD'],
    snippet: `snippet ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `sender-${id}@example.com` },
        { name: 'Subject', value: `Message ${id}` },
      ],
    },
  };
}

/** `count` history records starting at sequence id `startId`, one message each. */
function historyRecords(startId: number, count: number): gmail_v1.Schema$History[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(startId + i),
    messagesAdded: [{ message: { id: `m${startId + i}` } }],
  }));
}

function messageRefs(prefix: string, start: number, count: number): gmail_v1.Schema$Message[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${start + i}` }));
}

interface FakeGmailOptions {
  historyPages?: gmail_v1.Schema$ListHistoryResponse[];
  historyError?: unknown;
  messagePages?: gmail_v1.Schema$ListMessagesResponse[];
  profileHistoryId?: string;
}

/** Replays canned responses and records every call, in place of the live API. */
function fakeGmail(opts: FakeGmailOptions) {
  const calls = {
    history: [] as gmail_v1.Params$Resource$Users$History$List[],
    messages: [] as gmail_v1.Params$Resource$Users$Messages$List[],
    get: [] as string[],
    profile: 0,
  };
  let historyIndex = 0;
  let messageIndex = 0;

  const api = {
    users: {
      getProfile: async () => {
        calls.profile++;
        return {
          data: { emailAddress: 'me@example.com', historyId: opts.profileHistoryId ?? 'PROFILE' },
        };
      },
      history: {
        list: async (params: gmail_v1.Params$Resource$Users$History$List) => {
          calls.history.push(params);
          if (opts.historyError) throw opts.historyError;
          const page = opts.historyPages?.[historyIndex++];
          if (!page) throw new Error('fake ran out of history pages');
          return { data: page };
        },
      },
      messages: {
        list: async (params: gmail_v1.Params$Resource$Users$Messages$List) => {
          calls.messages.push(params);
          const page = opts.messagePages?.[messageIndex++];
          if (!page) throw new Error('fake ran out of message pages');
          return { data: page };
        },
        get: async ({ id }: { id: string }) => {
          calls.get.push(id);
          return { data: fakeMessage(id) };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;

  return { api, calls };
}

function clearStoredHistoryId(): void {
  prep(getDb(), 'DELETE FROM setting WHERE key = ?').run(KEY_HISTORY_ID);
}

describe('gmail inbox: historyId resume semantics', () => {
  test('gmail sync capped at a page boundary anchors at the last processed record', async () => {
    setSetting(KEY_HISTORY_ID, '100');
    const { api, calls } = fakeGmail({
      historyPages: [
        // 500 records (ids 101..600) fill the whole budget, and a nextPageToken
        // says more history exists beyond them.
        { history: historyRecords(101, 500), historyId: '9999', nextPageToken: 'page-2' },
      ],
    });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 500);
    assert.equal(calls.history.length, 1, 'the page beyond the cap must not be fetched');
    assert.equal(calls.history[0]!.startHistoryId, '100', 'listing must resume from the stored anchor');
    assert.equal(calls.profile, 0);
    // THE defect: persisting '9999' (the mailbox's current id) here would skip
    // everything between record 600 and now, forever.
    assert.equal(getSetting(KEY_HISTORY_ID), '600', 'anchor must be the last processed record, not the response historyId');
  });

  test('gmail sync capped mid-page ignores the response historyId even on the final page', async () => {
    setSetting(KEY_HISTORY_ID, '2000');
    const { api, calls } = fakeGmail({
      historyPages: [
        // 501 records on one page with no nextPageToken: the listing LOOKS
        // drained, but the 501st record was never collected.
        { history: historyRecords(2001, 501), historyId: '99999' },
      ],
    });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 500);
    assert.equal(calls.profile, 0);
    assert.equal(getSetting(KEY_HISTORY_ID), '2500', 'anchor must stop before the uncollected record');
  });

  test('gmail sync fully drained adopts the response-level historyId', async () => {
    setSetting(KEY_HISTORY_ID, '4000');
    const { api, calls } = fakeGmail({
      historyPages: [
        { history: historyRecords(4001, 3), historyId: '4600', nextPageToken: 'p2' },
        { history: historyRecords(4004, 2), historyId: '4600' },
      ],
    });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 5);
    assert.equal(calls.history.length, 2);
    // Drained means the response id is a truthful "caught up to here" — using
    // the last record id instead would re-list dead ground every sync.
    assert.equal(getSetting(KEY_HISTORY_ID), '4600');
  });

  test('gmail sync truncated fallback scan persists nothing', async () => {
    clearStoredHistoryId();
    const pages: gmail_v1.Schema$ListMessagesResponse[] = Array.from({ length: 5 }, (_, i) => ({
      messages: messageRefs('c', i * 100 + 1, 100),
      nextPageToken: `c-page-${i + 2}`, // every page, including the last one seen, has more behind it
    }));
    const { api, calls } = fakeGmail({ messagePages: pages });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 500);
    assert.equal(calls.history.length, 0, 'no stored anchor, so no incremental attempt');
    assert.equal(calls.profile, 0, 'a truncated scan must not even look up an anchor');
    // No anchor persisted: the next sync falls back again and alreadyStored()
    // carries it past this batch. Anchoring at "now" would orphan the remainder.
    assert.equal(getSetting(KEY_HISTORY_ID), null);
  });

  test('gmail sync second fallback pass advances past stored mail and re-anchors', async () => {
    // The stall this pins: pagination used to cap on LISTED ids, so a >cap
    // window re-listed the same newest 500 every pass and never reached the
    // older remainder. Fresh-gated paging walks straight past stored batches.
    clearStoredHistoryId();
    const passOne: gmail_v1.Schema$ListMessagesResponse[] = Array.from({ length: 5 }, (_, i) => ({
      messages: messageRefs('adv', i * 100 + 1, 100),
      nextPageToken: `adv-page-${i + 2}`,
    }));
    const passTwo: gmail_v1.Schema$ListMessagesResponse[] = Array.from({ length: 7 }, (_, i) => ({
      messages: messageRefs('adv', i * 100 + 1, 100),
      ...(i < 6 ? { nextPageToken: `adv2-page-${i + 2}` } : {}), // page 7 drains the window
    }));
    const { api } = fakeGmail({ messagePages: [...passOne, ...passTwo], profileHistoryId: 'ADV-ANCHOR' });

    const first = await syncInbox(async () => api);
    assert.equal(first, 500, 'first pass ingests one full cap');
    assert.equal(getSetting(KEY_HISTORY_ID), null, 'truncated pass anchors nothing');

    const second = await syncInbox(async () => api);
    assert.equal(second, 200, 'second pass reaches the 200 messages beyond the first cap');
    assert.equal(getSetting(KEY_HISTORY_ID), 'ADV-ANCHOR', 'a drained window finally anchors');
  });

  test('gmail sync completed fallback scan anchors at the profile historyId', async () => {
    clearStoredHistoryId();
    const { api, calls } = fakeGmail({
      messagePages: [{ messages: messageRefs('d', 1, 3) }], // no nextPageToken: drained
      profileHistoryId: 'PROFILE-77',
    });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 3);
    assert.equal(calls.profile, 1);
    assert.equal(getSetting(KEY_HISTORY_ID), 'PROFILE-77');
  });

  test('gmail sync completed scan cut by the batch cap still persists nothing', async () => {
    clearStoredHistoryId();
    const { api, calls } = fakeGmail({
      // One over budget on a single drained page: the listing is complete but
      // the 501st message is never fetched, so "synced up to now" would be a lie.
      messagePages: [{ messages: messageRefs('e', 1, 501) }],
      profileHistoryId: 'PROFILE-88',
    });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 500);
    assert.equal(calls.get.length, 500);
    assert.equal(calls.profile, 0);
    assert.equal(getSetting(KEY_HISTORY_ID), null);
  });

  test('gmail sync recovers from an expired historyId via the fallback scan', async () => {
    setSetting(KEY_HISTORY_ID, 'EXPIRED-1');
    const { api, calls } = fakeGmail({
      // Documented behaviour: an expired startHistoryId is a hard 404.
      historyError: Object.assign(new Error('Requested entity was not found.'), { status: 404 }),
      messagePages: [{ messages: messageRefs('f', 1, 2) }],
      profileHistoryId: 'PROFILE-99',
    });

    const inserted = await syncInbox(async () => api);

    assert.equal(inserted, 2);
    assert.equal(calls.history.length, 1);
    assert.equal(getSetting(KEY_HISTORY_ID), 'PROFILE-99', 'a completed recovery scan must replace the expired anchor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// connectGmail re-entrancy
// ─────────────────────────────────────────────────────────────────────────────

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Pull state + loopback address out of the consent URL the stub captured. */
function parseAuthUrl(url: string): { state: string; origin: string } {
  const parsed = new URL(url);
  const state = parsed.searchParams.get('state');
  const redirect = parsed.searchParams.get('redirect_uri');
  assert.ok(state, 'auth URL is missing state');
  assert.ok(redirect, 'auth URL is missing redirect_uri');
  return { state, origin: new URL(redirect).origin };
}

describe('gmail oauth: connect flow', () => {
  test('gmail connectGmail is re-entrant and a code-less redirect is an error page', async () => {
    await setSecret(KEY_CLIENT_ID, 'test-client-id.apps.googleusercontent.com');
    await setSecret(KEY_CLIENT_SECRET, 'test-client-secret');

    const openedBefore = openedExternally.length;

    // A double-click on Connect: both calls must share one consent flow, and
    // sharing the same promise OBJECT is the guarantee (an equal-looking second
    // flow would still open a second server and browser tab).
    const p1 = connectGmail();
    const p2 = connectGmail();
    assert.strictEqual(p1, p2, 'concurrent connectGmail calls must return the same in-flight promise');

    await waitFor(() => openedExternally.length > openedBefore, 'the consent URL to open');
    assert.equal(openedExternally.length, openedBefore + 1, 'two flows opened two consent tabs');

    const { state, origin } = parseAuthUrl(openedExternally[openedExternally.length - 1]!);

    // Redirect with a valid state but no code: the loopback page must report
    // failure, not "Gmail connected".
    const res = await fetch(`${origin}/oauth2callback?state=${encodeURIComponent(state)}`);
    const page = await res.text();
    assert.equal(res.status, 400);
    assert.ok(page.includes('Authorisation failed'), 'code-less redirect did not render the error page');
    assert.ok(!page.includes('Gmail connected'), 'code-less redirect rendered the success page');

    const result = await p1;
    assert.equal(result.ok, false);
    assert.match(result.message, /did not return an authorisation code/);

    // The guard releases once the flow settles: the next call is a new attempt.
    const p3 = connectGmail();
    assert.notStrictEqual(p3, p1, 'a settled flow must not be replayed to later callers');

    await waitFor(() => openedExternally.length > openedBefore + 1, 'the second consent URL to open');
    const second = parseAuthUrl(openedExternally[openedExternally.length - 1]!);
    await fetch(
      `${second.origin}/oauth2callback?state=${encodeURIComponent(second.state)}&error=access_denied`,
    );

    const r3 = await p3;
    assert.equal(r3.ok, false);
    assert.match(r3.message, /declined/);
  });
});
