/**
 * Real-Electron boot test. Not run under node:test — this file IS an Electron
 * main process. `bun run test:boot` bundles it and hands it to the electron
 * binary.
 *
 * What it proves that the stubbed e2e suite cannot: the actual main bundle
 * boots, the preload bridge exposes window.api across contextIsolation, the
 * renderer mounts real DOM (the blank-window failure mode), and a round trip
 * renderer → ipcMain → zod guard → SQLite comes back with data.
 *
 * The built renderer is served over http on the dev port, because an
 * unpackaged Electron always takes the isDev branch. Same HTML, same JS, same
 * preload as production — only the transport differs (http vs app://).
 */
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PORT = 5183;
const RENDERER_ROOT = path.resolve(__dirname, '../renderer');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const failures: string[] = [];
const consoleErrors: string[] = [];

function fail(msg: string): void {
  failures.push(msg);
  console.error(`✗ ${msg}`);
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

function serveRenderer(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = (req.url ?? '/').split('?')[0] ?? '/';
      const filePath = path.join(RENDERER_ROOT, rel === '/' ? 'index.html' : rel);
      if (!filePath.startsWith(RENDERER_ROOT + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${PORT} is busy — stop the dev server before running test:boot`));
      } else reject(err);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor<T>(what: string, ms: number, poll: () => T | null | undefined | Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await poll();
    if (got !== null && got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  // Fresh data dir: the app must boot from nothing (first-run path).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-boot-'));
  process.env.RECRUITAI_DATA = dataDir;

  if (!fs.existsSync(path.join(RENDERER_ROOT, 'index.html'))) {
    throw new Error(`built renderer not found at ${RENDERER_ROOT} — run \`bun run build\` first`);
  }
  const mainBundle = path.resolve(__dirname, '../main/index.cjs');
  if (!fs.existsSync(mainBundle)) {
    throw new Error(`built main not found at ${mainBundle} — run \`bun run build\` first`);
  }

  const server = await serveRenderer();
  ok(`static renderer server on :${PORT}`);

  // Boot the real app. Its own whenReady handler creates the window.
  require(mainBundle);

  await app.whenReady();

  const win = await waitFor('BrowserWindow', 15_000, () => BrowserWindow.getAllWindows()[0]);
  ok('BrowserWindow created');

  // Electron emits both the structured event (43.x) and legacy positional args.
  win.webContents.on('console-message', (event: unknown, ...legacy: unknown[]) => {
    const e = event as { level?: unknown; message?: unknown };
    if (typeof e?.level === 'string' && typeof e?.message === 'string') {
      if (e.level === 'error') consoleErrors.push(e.message);
    } else if (legacy[0] === 3) {
      consoleErrors.push(String(legacy[1]));
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    fail(`did-fail-load: ${code} ${desc}`);
  });

  await waitFor('page load', 15_000, () => !win.webContents.isLoading() || undefined);
  ok('page finished loading');

  // The blank-window check: React must actually put elements on screen.
  await waitFor('renderer DOM mount', 10_000, async () => {
    const n = await win.webContents.executeJavaScript(
      `document.getElementById('root')?.childElementCount ?? 0`,
    );
    return n > 0 || undefined;
  });
  ok('renderer mounted real DOM under #root');

  const apiShape = await win.webContents.executeJavaScript(
    `({ type: typeof window.api, methods: Object.keys(window.api ?? {}).length, hasOn: typeof window.api?.on === 'function' })`,
  );
  if (apiShape.type !== 'object') fail(`window.api is ${apiShape.type}, expected object`);
  else ok('window.api exposed through contextBridge');
  if (!apiShape.hasOn) fail('window.api.on missing');
  if (apiShape.methods < 40) fail(`window.api has ${apiShape.methods} methods, expected 44+on`);
  else ok(`window.api exposes ${apiShape.methods} methods`);

  // Full IPC round trip: renderer JS → preload → ipcMain → zod → SQLite → back.
  const stats = await win.webContents.executeJavaScript(`window.api.getStats()`);
  const statKeys = ['companies', 'reviewed', 'approved', 'contacts', 'verifiedContacts', 'openReqs', 'drafts', 'sent', 'replies', 'bounces'];
  const missing = statKeys.filter((k) => typeof stats?.[k] !== 'number');
  if (missing.length) fail(`getStats round trip missing numeric keys: ${missing.join(', ')}`);
  else ok('getStats IPC round trip returned a full DashboardStats');

  const settings = await win.webContents.executeJavaScript(`window.api.getSettings()`);
  if (!settings || typeof settings !== 'object') fail('getSettings round trip failed');
  else ok('getSettings IPC round trip returned settings');

  // A validated channel must reject garbage AT THE BOUNDARY — the error text
  // distinguishes a schema rejection from a handler crash further in.
  const guardCheck = await win.webContents.executeJavaScript(
    `window.api.patchCompany(123, "not-a-patch").then(() => 'accepted', (e) => String(e && e.message || e))`,
  );
  if (typeof guardCheck !== 'string' || !guardCheck.includes('Invalid arguments')) {
    fail(`zod guard did not reject malformed patchCompany at the boundary (got: ${guardCheck})`);
  } else ok('zod guard rejected malformed patchCompany input at the boundary');

  // ───────────────────────────────────────────────────────────────────────────
  // Bring-your-own Gmail OAuth client, over live IPC.
  //
  // This is the path that shipped broken: with no way to store a client,
  // connectGmail could only ever refuse, and the refusal was rendered into a
  // Toaster that the Setup wizard did not mount. Unit tests cover the schema;
  // only a real boot proves the channel reaches the keychain and that
  // getSettings reports back what the UI branches on.
  // ───────────────────────────────────────────────────────────────────────────

  if (settings?.gmail?.clientConfigured !== false) {
    fail(`fresh profile should report gmail.clientConfigured false (got ${settings?.gmail?.clientConfigured})`);
  } else ok('fresh profile reports no Gmail OAuth client configured');

  // With no client stored, Connect must refuse with the SETUP message rather
  // than throwing or opening a browser at a broken consent URL.
  const noClient = await win.webContents.executeJavaScript(
    `window.api.connectGmail().then((r) => r, (e) => ({ ok: null, message: String(e && e.message || e) }))`,
  );
  if (noClient?.ok !== false || !String(noClient?.message).includes('No Google OAuth client')) {
    fail(`connectGmail without a client should refuse with the setup message (got: ${JSON.stringify(noClient)})`);
  } else if (!String(noClient.message).includes('Settings → Gmail')) {
    fail('the refusal no longer points at where the fields actually are');
  } else ok('connectGmail without a client refuses with an actionable message');

  // A mispaste must be rejected at the boundary, not stored and then failed at
  // Google with an error the operator cannot act on.
  const badId = await win.webContents.executeJavaScript(
    `window.api.setGmailClient("123456789012", "GOCSPX-x").then(() => 'accepted', (e) => String(e && e.message || e))`,
  );
  if (typeof badId !== 'string' || !badId.includes('apps.googleusercontent.com')) {
    fail(`setGmailClient accepted a non-client-ID string (got: ${badId})`);
  } else ok('setGmailClient rejects a mispasted client ID at the boundary');

  // Half a client is refused: an id with no secret looks configured but fails.
  const halfClient = await win.webContents.executeJavaScript(
    `window.api.setGmailClient("123-abc.apps.googleusercontent.com", "").then(() => 'accepted', (e) => String(e && e.message || e))`,
  );
  if (halfClient !== 'accepted' && !String(halfClient).includes('both')) {
    fail(`half a client should be refused with a both-or-neither message (got: ${halfClient})`);
  } else if (halfClient === 'accepted') {
    fail('setGmailClient stored a client ID with no secret');
  } else ok('setGmailClient refuses a client ID with no secret');

  // The real round trip: store → keychain → getSettings reports configured.
  const stored = await win.webContents.executeJavaScript(
    `window.api.setGmailClient("123-abc.apps.googleusercontent.com", "GOCSPX-test-secret")
       .then(() => window.api.getSettings())
       .then((s) => s.gmail, (e) => ({ error: String(e && e.message || e) }))`,
  );
  if (stored?.error) fail(`setGmailClient round trip threw: ${stored.error}`);
  else if (stored?.clientConfigured !== true) {
    fail(`after storing a client, clientConfigured should be true (got ${JSON.stringify(stored)})`);
  } else ok('setGmailClient persists and getSettings reports clientConfigured');

  // Clearing must actually clear — otherwise a wrong client is unrecoverable
  // from the UI, which is how this whole area got stuck the first time.
  const cleared = await win.webContents.executeJavaScript(
    `window.api.setGmailClient("", "")
       .then(() => window.api.getSettings())
       .then((s) => s.gmail, (e) => ({ error: String(e && e.message || e) }))`,
  );
  if (cleared?.error) fail(`clearing the client threw: ${cleared.error}`);
  else if (cleared?.clientConfigured !== false) {
    fail(`clearing should set clientConfigured false (got ${JSON.stringify(cleared)})`);
  } else ok('the stored Gmail OAuth client can be cleared again');

  if (consoleErrors.length) {
    fail(`renderer console errors:\n  ${consoleErrors.join('\n  ')}`);
  } else {
    ok('zero renderer console errors');
  }

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  if (failures.length) {
    console.error(`\nBOOT TEST FAILED (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
    app.exit(1);
  } else {
    console.log('\nBOOT TEST PASSED');
    app.exit(0);
  }
}

main().catch((err) => {
  console.error('✗ boot test crashed:', err);
  app.exit(1);
});
