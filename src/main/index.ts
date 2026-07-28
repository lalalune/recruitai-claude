/**
 * Electron main process — app lifecycle, window, database, IPC registration.
 *
 * All backend logic lives here. The long-running work (source sweeps,
 * verification, sending) is network-bound rather than CPU-bound, so awaiting
 * HTTP yields to the event loop and the UI stays responsive; node:sqlite is
 * synchronous but its writes are sub-millisecond at this scale.
 */

import { app, BrowserWindow, protocol, net, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initDb, closeDb, getDb, backup } from './db/index.js';
import { registerIpc } from './ipc/index.js';
import { setPipelineWindow } from './pipeline/run.js';
import { startDrainer, stopDrainer } from './pipeline/drain.js';

const isDev = process.argv.includes('--dev') || !app.isPackaged;

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

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

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
      sandbox: false, // preload needs require() for the ipcRenderer bridge
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    mainWindow.loadURL('http://localhost:5183');
    // Opt-in rather than automatic: RECRUITAI_DEVTOOLS=1 bun run dev
    if (process.env.RECRUITAI_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('app://-/index.html');
  }

  // External links open in the real browser, never in the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
    const rel = pathname === '/' || pathname === '' ? '/index.html' : pathname;
    const filePath = path.join(root, decodeURIComponent(rel));

    // Never serve outside the renderer root.
    if (!filePath.startsWith(root)) {
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

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse();
    for (const stale of files.slice(7)) fs.unlinkSync(path.join(dir, stale));
  } catch (err) {
    console.error('[backup] failed:', err);
  }
}

app.whenReady().then(() => {
  initDb(path.join(DATA_DIR, 'recruitai.db'));
  if (!isDev) registerAppProtocol();
  createWindow();
  registerIpc(mainWindow!);
  setPipelineWindow(mainWindow);
  startDrainer();
  rotatingBackup();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopDrainer();
  closeDb();
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught:', err);
});
