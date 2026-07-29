/**
 * Electron main process — app lifecycle, window, database, IPC registration.
 *
 * All backend logic lives here. The long-running work (source sweeps,
 * verification, sending) is network-bound rather than CPU-bound, so awaiting
 * HTTP yields to the event loop and the UI stays responsive; node:sqlite is
 * synchronous but its writes are sub-millisecond at this scale.
 */

import { app, BrowserWindow, protocol, net, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initDb, closeDb, getDb, backup } from './db/index.js';
import { redactError } from './gmail/redact.js';
import { resolveWithin } from './util/apppath.js';
import { registerIpc, wireWindow } from './ipc/index.js';
import { pauseSending } from './ipc/outreach.js';
import { setPipelineWindow } from './pipeline/run.js';
import { startDrainer, stopDrainer } from './pipeline/drain.js';

const isDev = process.argv.includes('--dev') || !app.isPackaged;

/**
 * One instance only. Two processes sharing the SQLite file means two drainers,
 * double rate accounting, and reconcileInterruptedSends() in one instance
 * failing sends the other instance is mid-flight on.
 *
 * app.exit does not stop the rest of this module from evaluating (only
 * mkdirs — harmless), but whenReady below re-checks isPrimary so the losing
 * instance can never open the database or start the drainer.
 */
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Must be registered before app is ready, and before any window exists.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/**
 * Where the operator's data lives. Deliberately resolved in this order:
 *   1. RECRUITAI_DATA env var — explicit override, used by tests and power users
 *   2. a `recruitai-data` folder beside the executable — portable installs
 *   3. the OS userData directory — the default
 *
 * The repo's own ./data folder is gitignored and used in dev, which keeps company
 * data out of the open-source repository by construction.
 */
function resolveDataDir(): string {
  if (process.env.RECRUITAI_DATA) return process.env.RECRUITAI_DATA;
  if (isDev) return path.join(process.cwd(), 'data');
  const portable = path.join(path.dirname(app.getPath('exe')), 'recruitai-data');
  if (fs.existsSync(portable)) return portable;
  return app.getPath('userData');
}

const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'blobs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'exports'), { recursive: true });

// Set before whenReady, otherwise userData derives from the lowercase package name.
if (!isDev) app.setPath('userData', DATA_DIR);

// Retina machines capture at 2x, which makes screenshot evidence non-deterministic
// across machines. Pin the scale factor so a capture is comparable everywhere.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

export function dataDir(): string {
  return DATA_DIR;
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads still get require('electron') for the
      // contextBridge/ipcRenderer pair, which is all this preload uses.
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const startUrl = isDev ? 'http://localhost:5183' : 'app://-/index.html';
  mainWindow.loadURL(startUrl);
  // Opt-in rather than automatic: RECRUITAI_DEVTOOLS=1 bun run dev
  if (isDev && process.env.RECRUITAI_DEVTOOLS) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // External links open in the real browser, never in the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // A plain anchor around scraped content must not navigate the app shell —
  // window.open is covered above, top-frame navigation is covered here.
  //
  // Deny-by-default: the renderer is a single-page app, so the ONLY legitimate
  // top-frame navigation is back to its own entry. Origin comparison alone is
  // a trap in production — Node's URL gives every non-standard scheme
  // (app://, file://, data:) the same opaque origin 'null', which would make
  // "same origin" true for file:///etc/passwd. In dev the http origin is
  // compared properly ("http://localhost:5183" as a PREFIX would also admit
  // localhost:51830-51839).
  const devOrigin = isDev ? new URL(startUrl).origin : null;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let allowed = url === startUrl;
    if (!allowed && devOrigin) {
      try {
        allowed = new URL(url).origin === devOrigin;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    setPipelineWindow(null);
    mainWindow = null;
  });
}

/**
 * Serve the built renderer over a custom scheme rather than file://, which
 * would break fetch, module resolution and the CSP.
 */
function registerAppProtocol(): void {
  const root = path.join(__dirname, '../renderer');
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const filePath = resolveWithin(root, pathname);
    if (!filePath) {
      return new Response('Forbidden', { status: 403 });
    }
    // SPA fallback for unknown non-asset paths.
    const target = fs.existsSync(filePath) ? filePath : path.join(root, 'index.html');
    return net.fetch(pathToFileURL(target).toString());
  });
}

/** Keep the last 7 daily snapshots. VACUUM INTO gives a consistent copy without locking. */
function rotatingBackup(): void {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, `recruitai-${stamp}.db`);
    if (!fs.existsSync(dest)) backup(getDb(), dest);

    // Rotate ONLY the daily snapshots this function writes. The operator's
    // manual backups (recruitai-manual-*.db, via backupNow) sort above the
    // dailies lexicographically and a bare *.db filter deleted them.
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^recruitai-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    for (const stale of files.slice(7)) fs.unlinkSync(path.join(dir, stale));
  } catch (err) {
    console.error('[backup] failed:', err);
  }
}

/**
 * Electron's default is to GRANT every permission a page asks for, with no
 * prompt. This app needs none of them — it is a local SPA that talks to the
 * main process over IPC — so the whole class is refused rather than trusted to
 * stay unused. (The LinkedIn partition installs its own denial in
 * linkedin/session.ts; that one is the window where live third-party content
 * would otherwise be doing the asking.)
 */
function denyAllPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

app.whenReady().then(() => {
  if (!isPrimary) return;
  denyAllPermissions();
  initDb(path.join(DATA_DIR, 'recruitai.db'));
  if (!isDev) registerAppProtocol();
  createWindow();
  registerIpc(mainWindow!);
  setPipelineWindow(mainWindow);
  startDrainer();
  rotatingBackup();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      // A dock re-activation builds a fresh window; without rewiring it,
      // pipeline progress and send events go to the destroyed one.
      wireWindow(mainWindow!);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Pause BEFORE the db closes — the window's own 'closed' hook fires after
  // this and its pauseSending call would hit a closed database.
  try {
    pauseSending(getDb());
  } catch {
    /* db was never opened (early quit) — nothing to pause */
  }
  stopDrainer();
  closeDb();
});

process.on('uncaughtException', (err) => {
  // An escaped Google-client rejection carries the request (and its bearer
  // token) on the error object; printing it raw would put that in the log.
  console.error('[main] uncaught:', redactError(err));
});
