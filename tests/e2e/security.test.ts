/**
 * The security boundary of the main process.
 *
 * Everything here guards a property that fails SILENTLY when it breaks: a
 * webPreferences flag flipped in a refactor, a secret key the renderer can now
 * name, a credential that starts appearing in the log. None of it shows up by
 * using the app, so it is pinned here.
 */

// Must come first: patches require('electron') before any app module loads.
import { installElectronStub, registeredHandlers, makeFakeWindow, invokeHandler } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb, get, run } from '../../src/main/db/index.js';
import { registerIpc } from '../../src/main/ipc/index.js';
import { blobsDir } from '../../src/main/settings.js';
import { redactSecrets, redactError } from '../../src/main/gmail/redact.js';
import { isLinkedInUrl } from '../../src/main/linkedin/extract.js';

installElectronStub();

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-security-test-'));
  initDb(path.join(tmpRoot, 'security.db'));
  registerIpc(makeFakeWindow() as never);
});

after(() => {
  closeDb();
  try {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leaked temp dir must not fail the suite */
  }
});

function settingValue(key: string): string | null {
  return get<{ value: string }>(getDb(), 'SELECT value FROM setting WHERE key = ?', key)?.value ?? null;
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'shared', 'ipc.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the repo root from ${process.cwd()}`);
}

const ROOT = repoRoot();
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────

describe('setSecret cannot name a setting it does not own', () => {
  /**
   * secretKeySchema only constrains the SHAPE of the key. Without an allowlist
   * in the handler, the renderer names any row in the `setting` table — which
   * includes the Gmail grant and the two LinkedIn safety brakes.
   */
  const FORBIDDEN = [
    'gmail.refresh_token',
    'gmail.client_id',
    'gmail.client_secret',
    'gmail.address',
    'linkedin.halt',
    'linkedin.budget.2026-01-01',
    'keys.verifierProvider',
    'spendCapUsd',
  ];

  test('every setting key outside the two API keys is refused', async () => {
    for (const key of FORBIDDEN) {
      await assert.rejects(
        () => invokeHandler('setSecret', key, 'planted'),
        /Unknown secret/,
        `setSecret accepted "${key}" — the renderer can now write that row`,
      );
    }
  });

  test('an existing Gmail grant survives an attempt to overwrite it', async () => {
    run(
      getDb(),
      `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      'gmail.refresh_token',
      'raw:v1:the-real-token',
      Date.now(),
    );
    await assert.rejects(() => invokeHandler('setSecret', 'gmail.refresh_token', 'planted'));
    assert.equal(settingValue('gmail.refresh_token'), 'raw:v1:the-real-token');
  });

  /**
   * The LinkedIn brakes read their rows with JSON.parse and treat a parse
   * failure as "no halt" / "nothing spent". Writing an opaque secret blob
   * there is therefore not vandalism, it is a reset — precisely the retry path
   * around a day-stop that linkedin/session.ts promises does not exist.
   */
  test('the LinkedIn day-stop cannot be cleared through the secret channel', async () => {
    const halt = JSON.stringify({ day: '2026-01-01', reason: '429', kind: 'blocked', at: 1 });
    run(
      getDb(),
      `INSERT INTO setting (key, value, is_secret, updated_at) VALUES ('linkedin.halt', ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      halt,
      Date.now(),
    );
    await assert.rejects(() => invokeHandler('setSecret', 'linkedin.halt', 'anything'));
    assert.equal(settingValue('linkedin.halt'), halt);
  });

  test('the keys the Settings screen actually writes still work', async () => {
    await invokeHandler('setSecret', 'anthropic', 'sk-ant-sentinel-0001');
    await invokeHandler('setSecret', 'verifier', 'verifier-sentinel-0002');
    await invokeHandler('setSecret', 'verifier_provider', 'reoon');

    const settings = (await invokeHandler('getSettings')) as {
      keys: { anthropicKeySet: boolean; verifierKeySet: boolean; verifierProvider: string };
    };
    assert.equal(settings.keys.anthropicKeySet, true);
    assert.equal(settings.keys.verifierKeySet, true);
    assert.equal(settings.keys.verifierProvider, 'reoon');
  });

  test('no handler hands a secret VALUE back to the renderer', async () => {
    const settings = JSON.stringify(await invokeHandler('getSettings'));
    assert.ok(!settings.includes('sk-ant-sentinel-0001'), 'getSettings leaked the Anthropic key');
    assert.ok(!settings.includes('verifier-sentinel-0002'), 'getSettings leaked the verifier key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('handlers that touch the OS', () => {
  test('openExternal refuses every non-http(s) scheme', async () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vscode://x',
      'smb://host/share',
      // A control character can smuggle a second argument past a shell on some
      // platforms; the schema rejects it before shell.openExternal sees it.
      'https://example.com/\nfile:///etc/passwd',
    ]) {
      await assert.rejects(() => invokeHandler('openExternal', url), `openExternal accepted ${url}`);
    }
  });

  test('openExternal still opens an ordinary link', async () => {
    await invokeHandler('openExternal', 'https://example.com/jobs');
  });

  test('getScreenshot is confined to the blobs directory', async () => {
    for (const rel of ['/etc/passwd', '../../../etc/passwd', '..\\..\\secret', 'C:\\Windows\\win.ini']) {
      await assert.rejects(
        () => invokeHandler('getScreenshot', rel),
        /Invalid arguments/,
        `getScreenshot accepted ${rel}`,
      );
    }
  });

  test('getScreenshot serves an image inside blobs and nothing else', async () => {
    const dir = blobsDir();
    fs.mkdirSync(dir, { recursive: true });
    // 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(path.join(dir, 'shot.png'), png);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image');

    const ok = (await invokeHandler('getScreenshot', 'shot.png')) as string | null;
    assert.ok(ok?.startsWith('data:image/png;base64,'), 'a real blob screenshot did not load');

    // Extension allowlist: the handler must not turn an arbitrary readable file
    // into a data: URL just because it sits in the right directory.
    assert.equal(await invokeHandler('getScreenshot', 'notes.txt'), null);
    assert.equal(await invokeHandler('getScreenshot', 'missing.png'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('credentials never reach a log line', () => {
  /**
   * gaxios attaches the whole request to the error it throws, and Node's
   * console prints an Error's own enumerable properties. Two of those carry a
   * live credential: `Authorization: Bearer <access token>` on every API call,
   * and — because google-auth-library builds `/revoke?token=<refresh token>` —
   * the refresh token itself in `config.url`.
   */
  test('a gaxios-shaped revoke failure loses both the token and the bearer', () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      config: {
        url: 'https://oauth2.googleapis.com/revoke?token=1//SUPERSECRETREFRESH',
        method: 'POST',
        headers: { Authorization: 'Bearer ya29.SUPERSECRETACCESS' },
      },
      response: { status: 400, config: { url: 'https://oauth2.googleapis.com/revoke?token=1//SUPERSECRETREFRESH' } },
    });

    const line = redactError(err);
    assert.ok(!line.includes('SUPERSECRETREFRESH'), `refresh token survived redaction:\n${line}`);
    assert.ok(!line.includes('SUPERSECRETACCESS'), `access token survived redaction:\n${line}`);
    // Still useful to whoever reads the log.
    assert.match(line, /oauth2\.googleapis\.com/);
    assert.match(line, /status code 400/);
  });

  test('the common credential spellings are all covered', () => {
    const samples = [
      'POST https://x/token?client_secret=abcdefgh&grant_type=x',
      '{"refresh_token":"1//abcdefgh","expiry":1}',
      "headers: { 'x-api-key': 'sk-ant-abcdefgh' }",
      'authorization: bearer ya29.abcdefgh',
      'https://api.example.com/v1?api_key=abcdefgh',
    ];
    for (const sample of samples) {
      assert.ok(!redactSecrets(sample).includes('abcdefgh'), `not redacted: ${redactSecrets(sample)}`);
    }
  });

  test('redaction leaves the diagnostic intact', () => {
    // Nothing here is a credential, and classifyGmailError's own branching
    // reads these strings back out of the redacted message.
    for (const plain of [
      'Draft generation failed for company 01J: no open requisition to write about.',
      'code: invalid_grant',
      'Token has been expired or revoked.',
      'Request failed with status code 401',
    ]) {
      assert.equal(redactSecrets(plain), plain);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the LinkedIn worker only ever scripts LinkedIn', () => {
  /**
   * Everything extract.ts injects into a page — the session's csrf-token above
   * all — is only safe because the page is LinkedIn's. A redirect off-site is
   * neither a checkpoint nor an auth wall, so the two existing guards miss it.
   */
  test('lookalike hosts are not LinkedIn', () => {
    for (const url of [
      'https://linkedin.com.evil.com/company/x',
      'https://evil.com/?next=https://www.linkedin.com/',
      'https://notlinkedin.com/',
      'https://www.linkedin.com.attacker.io/feed/',
      'javascript:fetch("/voyager")',
      'file:///etc/passwd',
      '',
      'not a url',
    ]) {
      assert.equal(isLinkedInUrl(url), false, `${url} was treated as LinkedIn`);
    }
  });

  test('the hosts the module actually visits are LinkedIn', () => {
    for (const url of [
      'https://www.linkedin.com/company/acme/people/',
      'https://linkedin.com/in/somebody',
      'https://www.linkedin.com/voyager/api/organization/companies?q=universalName',
    ]) {
      assert.equal(isLinkedInUrl(url), true, `${url} was rejected`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Electron hardening stays hardened', () => {
  /**
   * A flipped webPreferences flag is invisible at runtime until something goes
   * badly wrong, and none of these windows can be constructed in a test — the
   * worker and login windows are internal, and createWindow only runs behind
   * app.whenReady(). So this reads the declarations.
   */
  const WINDOW_FILES = [
    'src/main/index.ts',
    'src/main/linkedin/session.ts',
    'src/main/linkedin/extract.ts',
  ];

  test('every BrowserWindow isolates the renderer', () => {
    let checked = 0;
    for (const file of WINDOW_FILES) {
      const src = readSrc(file);
      for (const match of src.matchAll(/webPreferences:\s*\{/g)) {
        const block = balanced(src, match.index + match[0].length - 1);
        checked++;
        assert.match(block, /contextIsolation:\s*true/, `${file}: contextIsolation is not true`);
        assert.match(block, /nodeIntegration:\s*false/, `${file}: nodeIntegration is not false`);
        assert.match(block, /sandbox:\s*true/, `${file}: sandbox is not true`);
        assert.ok(!/webSecurity:\s*false/.test(block), `${file}: webSecurity is disabled`);
        assert.ok(
          !/allowRunningInsecureContent:\s*true/.test(block),
          `${file}: insecure content is allowed`,
        );
        assert.ok(!/webviewTag:\s*true/.test(block), `${file}: the webview tag is enabled`);
      }
    }
    assert.ok(checked >= 3, `only found ${checked} webPreferences blocks — did the parse break?`);
  });

  test('only the app window gets a preload', () => {
    // A preload on a window showing a third-party site would put the whole IPC
    // surface behind LinkedIn's origin.
    for (const file of ['src/main/linkedin/session.ts', 'src/main/linkedin/extract.ts']) {
      assert.ok(!readSrc(file).includes('preload'), `${file} attaches a preload to a LinkedIn window`);
    }
  });

  test('the LinkedIn windows run on their own persistent partition', () => {
    for (const file of ['src/main/linkedin/session.ts', 'src/main/linkedin/extract.ts']) {
      assert.match(readSrc(file), /partition:\s*LINKEDIN_PARTITION/, `${file} shares the app session`);
    }
  });

  test('permission requests are refused rather than silently granted', () => {
    // Electron's default is to grant every permission with no prompt.
    assert.match(readSrc('src/main/index.ts'), /setPermissionRequestHandler/);
    assert.match(readSrc('src/main/linkedin/session.ts'), /setPermissionRequestHandler/);
  });

  test('the renderer CSP admits no remote origin and no eval', () => {
    const html = readSrc('src/renderer/index.html');
    const csp = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1];
    assert.ok(csp, 'no Content-Security-Policy meta tag found');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-src 'none'/);
    assert.ok(!csp.includes('unsafe-eval'), 'CSP allows eval');
    // localhost is the dev server; anything else remote is a supply-chain hole.
    const remote = csp.match(/https?:\/\/(?!localhost)[\w.-]+/g) ?? [];
    assert.deepEqual(remote, [], `CSP allows remote origins: ${remote.join(', ')}`);
  });

  test('the preload exposes the declared API and nothing raw', () => {
    const src = readSrc('src/main/preload.ts');
    assert.match(src, /exposeInMainWorld\('api'/);
    // Handing the renderer ipcRenderer itself would make every channel — and
    // every internal Electron channel — reachable regardless of the METHODS list.
    assert.ok(
      !/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(src),
      'preload exposes ipcRenderer directly',
    );
    assert.ok(!src.includes('nodeRequire') && !src.includes("require('node:"), 'preload reaches into Node');
  });

  test('every exposed method is a channel with an input schema', async () => {
    const { CHANNEL_NAMES } = await import('../../src/shared/schemas.js');
    for (const channel of registeredHandlers.keys()) {
      assert.ok(
        (CHANNEL_NAMES as readonly string[]).includes(channel),
        `${channel} is registered with no schema — its arguments are unvalidated`,
      );
    }
  });
});

/** The `{...}` block starting at `open`, including both braces. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced braces');
}
