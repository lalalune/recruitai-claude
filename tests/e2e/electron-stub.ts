/**
 * A fake `electron` module, installed into Node's module loader.
 *
 * The test bundle marks `electron` external (see scripts/run-tests.mjs), so any
 * `require('electron')` inside the app graph reaches the real loader and throws
 * MODULE_NOT_FOUND — Electron's binding only exists inside the Electron runtime.
 * Patching `Module._load` intercepts every such require.
 *
 * NOTE: a native dynamic `await import('electron')` is NOT intercepted —
 * esbuild preserves it as real ESM import in CJS output, which resolves the
 * electron npm package (a path string) and bypasses this stub entirely. The
 * lazy loaders in gmail/oauth.ts, linkedin/session.ts and linkedin/extract.ts
 * therefore use createRequire/ambient require first; keep any new lazy
 * electron loader on the require path too.
 *
 * IMPORT THIS FIRST. esbuild concatenates modules in import order, so the patch
 * is only in place before the app's `require("electron")` runs if this module is
 * the first import in the test file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

type AnyFn = (...args: any[]) => any;
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

/** Every channel handed to `ipcMain.handle`, in registration order. */
export const registeredHandlers = new Map<string, IpcHandler>();

/** Everything main tried to push to a renderer via `webContents.send`. */
export const sentEvents: { channel: string; payload: unknown }[] = [];

/** URLs handed to `shell.openExternal` / `shell.openPath`. */
export const openedExternally: string[] = [];

/**
 * A scratch directory standing in for the OS userData dir. Set into
 * RECRUITAI_DATA below so that importing src/main/index.ts — which resolves and
 * mkdirs its data directory at module scope — can never touch the repo's ./data.
 */
export const stubDataDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-electron-stub-'));

if (!process.env.RECRUITAI_DATA) process.env.RECRUITAI_DATA = stubDataDir;

// rmSync is synchronous, so it completes inside an 'exit' handler.
process.on('exit', () => {
  try {
    fs.rmSync(stubDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* best effort — a leaked temp dir is not worth failing a run over */
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

function subdir(name: string): string {
  const dir = path.join(stubDataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class FakeEmitter {
  readonly listeners = new Map<string, AnyFn[]>();
  on(event: string, fn: AnyFn): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }
  once(event: string, fn: AnyFn): this {
    return this.on(event, fn);
  }
  off(event: string, fn: AnyFn): this {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((f) => f !== fn));
    return this;
  }
  removeListener(event: string, fn: AnyFn): this {
    return this.off(event, fn);
  }
  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const list = this.listeners.get(event) ?? [];
    const snapshot = Array.from(list); // listeners may unsubscribe mid-emit
    for (const fn of snapshot) fn(...args);
    return list.length > 0;
  }
}

class FakeWebContents extends FakeEmitter {
  static counter = 0;
  readonly id = ++FakeWebContents.counter;
  session = fakeSession;

  send(channel: string, payload: unknown): void {
    sentEvents.push({ channel, payload });
  }
  loadURL(url: string): Promise<void> {
    this.lastUrl = url;
    return Promise.resolve();
  }
  getURL(): string {
    return this.lastUrl;
  }
  setWindowOpenHandler(_fn: AnyFn): void {}
  openDevTools(_opts?: unknown): void {}
  closeDevTools(): void {}
  executeJavaScript(_code: string): Promise<unknown> {
    return Promise.resolve(null);
  }
  insertCSS(_css: string): Promise<string> {
    return Promise.resolve('');
  }
  setAudioMuted(_muted: boolean): void {}
  setUserAgent(_ua: string): void {}
  stop(): void {}
  private lastUrl = '';
}

const allWindows: FakeBrowserWindow[] = [];

class FakeBrowserWindow extends FakeEmitter {
  readonly webContents = new FakeWebContents();
  readonly options: Record<string, unknown>;
  private destroyed = false;

  constructor(options: Record<string, unknown> = {}) {
    super();
    this.options = options;
    allWindows.push(this);
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return allWindows.filter((w) => !w.isDestroyed());
  }
  static fromWebContents(wc: FakeWebContents): FakeBrowserWindow | null {
    return allWindows.find((w) => w.webContents === wc) ?? null;
  }

  loadURL(url: string): Promise<void> {
    return this.webContents.loadURL(url);
  }
  loadFile(_file: string): Promise<void> {
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }
  close(): void {
    this.destroy();
  }
  show(): void {}
  hide(): void {}
  focus(): void {}
  blur(): void {}
  minimize(): void {}
  setMenu(_menu: unknown): void {}
  removeMenu(): void {}
  setTitle(_title: string): void {}
}

const fakeSession = {
  cookies: {
    get: async (_filter: unknown) => [] as unknown[],
    set: async (_details: unknown) => undefined,
    remove: async (_url: string, _name: string) => undefined,
  },
  webRequest: {
    onBeforeSendHeaders: (_filter: unknown, _fn?: AnyFn) => undefined,
    onHeadersReceived: (_filter: unknown, _fn?: AnyFn) => undefined,
  },
  clearStorageData: async (_opts?: unknown) => undefined,
  setUserAgent: (_ua: string) => undefined,
  setPermissionRequestHandler: (_fn: AnyFn | null) => undefined,
  protocol: { handle: (_scheme: string, _fn: AnyFn) => undefined },
};

const appEmitter = new FakeEmitter();

const fakeApp = {
  // Reported false so src/main/index.ts takes its dev branch, where the data
  // directory comes from RECRUITAI_DATA rather than from app.getPath('exe').
  isPackaged: false,
  isReady: () => true,
  /**
   * Never resolves. Importing src/main/index.ts must not be allowed to run its
   * bootstrap (initDb, createWindow, registerIpc) behind the test's back — the
   * tests open their own database and call registerIpc themselves.
   */
  whenReady: () => new Promise<void>(() => {}),
  getPath: (name: string) => subdir(name),
  setPath: (_name: string, _value: string) => undefined,
  getAppPath: () => stubDataDir,
  getName: () => 'recruitai',
  getVersion: () => '0.0.0-test',
  requestSingleInstanceLock: () => true,
  setName: (_name: string) => undefined,
  quit: () => undefined,
  exit: (_code?: number) => undefined,
  relaunch: () => undefined,
  focus: () => undefined,
  commandLine: {
    appendSwitch: (_k: string, _v?: string) => undefined,
    appendArgument: (_a: string) => undefined,
    hasSwitch: (_k: string) => false,
    getSwitchValue: (_k: string) => '',
  },
  on: (event: string, fn: AnyFn) => appEmitter.on(event, fn),
  once: (event: string, fn: AnyFn) => appEmitter.once(event, fn),
  off: (event: string, fn: AnyFn) => appEmitter.off(event, fn),
  removeListener: (event: string, fn: AnyFn) => appEmitter.removeListener(event, fn),
  removeAllListeners: (event?: string) => appEmitter.removeAllListeners(event),
  emit: (event: string, ...args: unknown[]) => appEmitter.emit(event, ...args),
};

const fakeIpcMain = {
  // Real ipcMain throws on a duplicate rather than overwriting. Reproducing that
  // is what lets a test prove registerIpc() is safely re-entrant.
  handle: (channel: string, handler: IpcHandler) => {
    if (registeredHandlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    registeredHandlers.set(channel, handler);
  },
  handleOnce: (channel: string, handler: IpcHandler) => {
    if (registeredHandlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    registeredHandlers.set(channel, handler);
  },
  removeHandler: (channel: string) => {
    registeredHandlers.delete(channel);
  },
  on: (_channel: string, _fn: AnyFn) => fakeIpcMain,
  once: (_channel: string, _fn: AnyFn) => fakeIpcMain,
  off: (_channel: string, _fn: AnyFn) => fakeIpcMain,
  removeAllListeners: (_channel?: string) => fakeIpcMain,
};

/**
 * safeStorage reports encryption UNAVAILABLE on purpose: that is the path a
 * Linux desktop with no keyring takes, and it is the path where secrets fall
 * back to marked plaintext. Testing the happy path would leave the fallback —
 * the one with the interesting failure mode — completely unexercised.
 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
  decryptString: (buf: Buffer) => Buffer.from(buf).toString('utf8'),
  getSelectedStorageBackend: () => 'basic_text',
};

const fakeShell = {
  openExternal: async (url: string) => {
    openedExternally.push(url);
  },
  openPath: async (target: string) => {
    openedExternally.push(target);
    return '';
  },
  showItemInFolder: (_target: string) => undefined,
  trashItem: async (_target: string) => undefined,
};

const fakeProtocol = {
  registerSchemesAsPrivileged: (_schemes: unknown[]) => undefined,
  handle: (_scheme: string, _fn: AnyFn) => undefined,
  unhandle: (_scheme: string) => undefined,
  isProtocolHandled: async (_scheme: string) => false,
};

const fakeNet = {
  fetch: async (_url: string, _opts?: unknown) => new Response('', { status: 204 }),
  isOnline: () => true,
};

const fakeUtilityProcess = {
  fork: (_modulePath: string, _args?: string[], _opts?: unknown) => {
    const child = new FakeEmitter() as FakeEmitter & {
      pid: number;
      postMessage: AnyFn;
      kill: AnyFn;
    };
    child.pid = process.pid;
    child.postMessage = () => undefined;
    child.kill = () => true;
    return child;
  },
};

export const electronStub = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  ipcMain: fakeIpcMain,
  ipcRenderer: {
    invoke: async (_channel: string, ..._args: unknown[]) => undefined,
    on: (_channel: string, _fn: AnyFn) => undefined,
    removeListener: (_channel: string, _fn: AnyFn) => undefined,
    send: (_channel: string, ..._args: unknown[]) => undefined,
  },
  contextBridge: { exposeInMainWorld: (_key: string, _api: unknown) => undefined },
  safeStorage: fakeSafeStorage,
  shell: fakeShell,
  protocol: fakeProtocol,
  net: fakeNet,
  session: {
    fromPartition: (_partition: string, _opts?: unknown) => fakeSession,
    defaultSession: fakeSession,
  },
  utilityProcess: fakeUtilityProcess,
  dialog: {
    showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
    showErrorBox: (_t: string, _c: string) => undefined,
  },
  nativeImage: { createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
  nativeTheme: { shouldUseDarkColors: true, on: (_e: string, _f: AnyFn) => undefined },
  clipboard: { writeText: (_t: string) => undefined, readText: () => '' },
  Menu: { setApplicationMenu: (_m: unknown) => undefined, buildFromTemplate: (_t: unknown[]) => ({}) },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1, workAreaSize: { width: 1440, height: 900 } }) },
  powerMonitor: new FakeEmitter(),
  crashReporter: { start: (_opts: unknown) => undefined },
};

// ─────────────────────────────────────────────────────────────────────────────
// Installation
// ─────────────────────────────────────────────────────────────────────────────

interface LoaderModule {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

let installed = false;

/**
 * Idempotent. Also runs on import (see the call below) so that import order
 * alone is enough to guarantee the patch precedes any app-module evaluation.
 */
export function installElectronStub(): typeof electronStub {
  if (installed) return electronStub;
  installed = true;

  // createRequire rather than a bare `require`: this file is authored as ESM,
  // and this reaches the genuine Module class rather than an interop wrapper.
  const nodeRequire = createRequire(path.join(process.cwd(), 'noop.cjs'));
  const loader = nodeRequire('node:module') as unknown as LoaderModule;
  const original = loader._load;

  loader._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron' || request === 'node:electron') return electronStub;
    return original.call(this, request, parent, isMain);
  };

  return electronStub;
}

installElectronStub();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for tests
// ─────────────────────────────────────────────────────────────────────────────

/** Invoke a registered IPC handler the way the renderer would. */
export async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for "${channel}"`);
  return handler({ sender: {} }, ...args);
}

/** A window object good enough for registerIpc() and the event emitters. */
export function makeFakeWindow(): FakeBrowserWindow {
  return new FakeBrowserWindow({ width: 1440, height: 900 });
}

export function clearSentEvents(): void {
  sentEvents.length = 0;
}

export type { FakeBrowserWindow };
