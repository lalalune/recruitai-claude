/**
 * The contract that keeps the renderer and the main process in sync.
 *
 * Every one of these failures presents identically in the app — the operator
 * clicks something and nothing happens, with no error anywhere — so none of
 * them are caught by using the app. They are only caught here.
 *
 * The three declarations (RecruitApi, the preload METHODS array, the ipcMain
 * registrations) are parsed out of the source at run time rather than restated,
 * so this test cannot drift away from the thing it is checking.
 */

// Must come first: patches require('electron') before any app module is evaluated.
import { installElectronStub, registeredHandlers, makeFakeWindow, invokeHandler } from './electron-stub.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb } from '../../src/main/db/index.js';
import { registerIpc } from '../../src/main/ipc/index.js';
import { getPipelineState } from '../../src/main/pipeline/run.js';

installElectronStub();

// ─────────────────────────────────────────────────────────────────────────────
// Source parsing
// ─────────────────────────────────────────────────────────────────────────────

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

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Strips comments so `//` and `/* *\/` can never be mistaken for declarations. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The text between the braces of `export interface <name> { ... }`. */
function interfaceBody(src: string, name: string): string {
  const marker = new RegExp(`export interface ${name}\\s*(?:extends [^{]+)?\\{`);
  const match = marker.exec(src);
  assert.ok(match, `export interface ${name} not found`);

  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`Unbalanced braces in interface ${name}`);
}

/** Split an interface body into its members, ignoring `;` inside nested types. */
function members(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ';' && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function methodNames(src: string, interfaceName: string): string[] {
  return members(interfaceBody(stripComments(src), interfaceName))
    .map((m) => /^([A-Za-z_$][\w$]*)\s*\(/.exec(m)?.[1])
    .filter((n): n is string => Boolean(n));
}

function eventNames(src: string, interfaceName: string): string[] {
  return members(interfaceBody(stripComments(src), interfaceName))
    .map((m) => /^'([^']+)'\s*:/.exec(m)?.[1])
    .filter((n): n is string => Boolean(n));
}

/** Members of a `export type X = 'a' | 'b';` union. */
function unionMembers(src: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`).exec(stripComments(src));
  assert.ok(match, `export type ${typeName} not found`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Members of a `const NAME = [ 'a', 'b' ] as const;` array literal. */
function stringArrayLiteral(src: string, name: string): string[] {
  const match = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(stripComments(src));
  assert.ok(match, `const ${name} = [...] not found`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

function diff(expected: readonly string[], actual: readonly string[]) {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    missing: [...e].filter((x) => !a.has(x)).sort(),
    extra: [...a].filter((x) => !e.has(x)).sort(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const IPC_SRC = readSource('src/shared/ipc.ts');
const PRELOAD_SRC = readSource('src/main/preload.ts');

const API_METHODS = methodNames(IPC_SRC, 'RecruitApi');
const API_EVENTS = eventNames(IPC_SRC, 'RecruitEvents');
const SOURCE_KEYS = unionMembers(IPC_SRC, 'SourceKey');
const PRELOAD_METHODS = stringArrayLiteral(PRELOAD_SRC, 'METHODS');
const PRELOAD_EVENTS = stringArrayLiteral(PRELOAD_SRC, 'EVENTS');

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recruitai-ipc-test-'));
  initDb(path.join(tmpRoot, 'contract.db'));
  registerIpc(makeFakeWindow() as never);
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

describe('parsing sanity', () => {
  test('the parser actually found the declarations', () => {
    // If the parser silently returned nothing, every comparison below would
    // trivially pass. These floors make that impossible.
    assert.ok(API_METHODS.length >= 40, `only parsed ${API_METHODS.length} RecruitApi methods`);
    assert.ok(SOURCE_KEYS.length >= 8, `only parsed ${SOURCE_KEYS.length} SourceKeys`);
    assert.ok(API_EVENTS.length >= 4, `only parsed ${API_EVENTS.length} RecruitEvents`);
    assert.ok(PRELOAD_METHODS.length >= 40, `only parsed ${PRELOAD_METHODS.length} preload methods`);

    assert.equal(new Set(API_METHODS).size, API_METHODS.length, 'RecruitApi declares a method twice');
    assert.equal(new Set(PRELOAD_METHODS).size, PRELOAD_METHODS.length, 'preload METHODS contains a duplicate');
    assert.equal(new Set(SOURCE_KEYS).size, SOURCE_KEYS.length, 'SourceKey declares a key twice');

    // Spot-checks so a regex that matched the wrong construct fails loudly.
    for (const expected of ['listCompanies', 'getSettings', 'runSource', 'getScreenshot']) {
      assert.ok(API_METHODS.includes(expected), `RecruitApi parse missed ${expected}`);
    }
  });
});

describe('main ↔ renderer', () => {
  test('every RecruitApi method has a registered ipcMain handler', () => {
    const registered = [...registeredHandlers.keys()];
    const { missing, extra } = diff(API_METHODS, registered);

    assert.deepEqual(
      missing,
      [],
      `RecruitApi declares these but nothing calls ipcMain.handle for them — ` +
        `the renderer would hang forever: ${missing.join(', ')}`,
    );
    assert.deepEqual(
      extra,
      [],
      `ipcMain handlers with no RecruitApi declaration (dead channels or a typo): ${extra.join(', ')}`,
    );
    assert.equal(registered.length, API_METHODS.length);
  });

  test('the preload METHODS array matches RecruitApi exactly', () => {
    const { missing, extra } = diff(API_METHODS, PRELOAD_METHODS);

    assert.deepEqual(
      missing,
      [],
      `declared on RecruitApi but absent from preload METHODS, so window.api.<name> ` +
        `is undefined at runtime: ${missing.join(', ')}`,
    );
    assert.deepEqual(
      extra,
      [],
      `exposed by preload with no RecruitApi declaration: ${extra.join(', ')}`,
    );
  });

  test('the preload EVENTS array matches RecruitEvents exactly', () => {
    const { missing, extra } = diff(API_EVENTS, PRELOAD_EVENTS);
    assert.deepEqual(missing, [], `main can emit these but preload silently drops them: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `preload subscribes to events main never emits: ${extra.join(', ')}`);
  });

  test('every registered handler is callable', () => {
    for (const [channel, handler] of registeredHandlers) {
      assert.equal(typeof handler, 'function', `handler for ${channel} is not a function`);
    }
  });

  /**
   * Registration alone only proves the channel exists. These are the read-only
   * handlers the UI calls on first paint: if any of them throws, the app opens
   * to an empty screen with the error buried in a rejected invoke().
   */
  test('the handlers the UI calls on first paint actually return', async () => {
    assert.deepEqual(await invokeHandler('listCompanies', {}), []);
    assert.deepEqual(await invokeHandler('listSuppressions'), []);
    assert.deepEqual(await invokeHandler('listDrafts'), []);
    assert.equal(await invokeHandler('getCompany', 'nonexistent-id'), null);

    const stats = (await invokeHandler('getStats')) as Record<string, number>;
    assert.equal(stats.companies, 0);
    assert.equal(stats.contacts, 0);

    const settings = (await invokeHandler('getSettings')) as { icp: { staleDays: number }; dataDir: string };
    assert.equal(settings.icp.staleDays, 45);
    assert.ok(settings.dataDir.length > 0);

    const pipeline = (await invokeHandler('getPipeline')) as { sources: unknown[]; running: boolean };
    assert.ok(pipeline.sources.length > 0);
    assert.equal(pipeline.running, false);

    const sendStats = (await invokeHandler('getSendStats')) as { queued: number; running: boolean };
    assert.equal(sendStats.queued, 0);
    assert.equal(sendStats.running, false);
  });

  test('openExternal refuses anything that is not http(s)', async () => {
    await assert.rejects(() => invokeHandler('openExternal', 'file:///etc/passwd'));
    await assert.rejects(() => invokeHandler('openExternal', 'javascript:alert(1)'));
  });

  /**
   * The schemas in src/shared/schemas.ts once existed as fully-tested dead
   * code: every handler was registered through raw ipcMain.handle and never
   * consulted them. These two tests make that failure mode impossible to
   * reintroduce silently.
   */
  test('every channel rejects an over-arity call — proves the guard wraps it', async () => {
    for (const [channel] of registeredHandlers) {
      await assert.rejects(
        () => invokeHandler(channel, ...Array<string>(9).fill('junk')),
        /Invalid arguments|Unknown IPC channel/,
        `${channel} accepted 9 junk arguments — is it registered through guard.handle()?`,
      );
    }
  });

  test('validation rejects garbage before it reaches a handler', async () => {
    // Wrong types must die at the boundary with a readable message, not
    // surface as "Unknown company: 123" from a database lookup.
    await assert.rejects(
      () => invokeHandler('patchCompany', 123, 'not-a-patch'),
      /Invalid arguments for "patchCompany"/,
    );
    await assert.rejects(
      () => invokeHandler('runSource', 'not-a-source'),
      /Invalid arguments for "runSource"/,
    );
    await assert.rejects(
      () => invokeHandler('addSuppression', 'domain', 'example.com', 'no_agency'),
      /Invalid arguments for "addSuppression"/,
      'the pre-rename suppression reason must be rejected by the schema',
    );
    await assert.rejects(
      () => invokeHandler('getScreenshot', '../../../etc/passwd'),
      /Invalid arguments for "getScreenshot"/,
    );
  });

  test('no ipc module bypasses the validating guard', () => {
    const dir = path.join(ROOT, 'src', 'main', 'ipc');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts') || file === 'guard.ts') continue;
      const src = stripComments(readSource(path.join('src', 'main', 'ipc', file)));
      assert.ok(
        !src.includes('ipcMain.handle('),
        `${file} calls ipcMain.handle directly — register through guard.handle() so the schema applies`,
      );
    }
  });

  test('registerIpc is re-entrant', () => {
    // ipcMain.handle throws on a duplicate channel (the stub reproduces that),
    // so this only passes if registerIpc removes every channel it registers.
    assert.doesNotThrow(() => registerIpc(makeFakeWindow() as never));
    assert.equal(registeredHandlers.size, API_METHODS.length);
  });
});

describe('pipeline sources', () => {
  test('every SourceKey has a runner registered in the pipeline', () => {
    const state = getPipelineState();
    const wired = state.sources.map((s) => s.key as string);
    const { missing, extra } = diff(SOURCE_KEYS, wired);

    assert.deepEqual(
      missing,
      [],
      `declared as a SourceKey but has no runner in src/main/pipeline/run.ts, ` +
        `so the Sources screen can never run it: ${missing.join(', ')}`,
    );
    assert.deepEqual(extra, [], `run.ts wires a source that is not a SourceKey: ${extra.join(', ')}`);
  });

  test('every source is presentable in the UI', () => {
    for (const source of getPipelineState().sources) {
      assert.ok(source.label.length > 0, `${source.key} has no label`);
      assert.ok(source.description.length > 0, `${source.key} has no description`);
      assert.equal(typeof source.enabled, 'boolean');
      assert.equal(typeof source.running, 'boolean');
      assert.ok(
        source.estimatedCostUsd === null || Number.isFinite(source.estimatedCostUsd),
        `${source.key} reports a nonsense cost estimate`,
      );
    }
  });
});
