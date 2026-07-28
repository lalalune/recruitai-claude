/**
 * Validating replacement for `ipcMain.handle`.
 *
 * Every channel registered through here parses its arguments against the tuple
 * in src/shared/schemas.ts before the handler runs, and the handler is called
 * with the *parsed* values so trimming, URL normalisation and `.default({})`
 * all take effect exactly once, at the boundary.
 *
 * The `electron` import is deliberately lazy. `validateChannel` is the part
 * worth unit-testing, and the test bundle marks `electron` external — a static
 * import here would make this module unloadable outside the app.
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { Schemas, channelArity, isChannelName, type ChannelName } from '../../shared/schemas.js';

export interface ChannelValidation {
  ok: boolean;
  /** Parsed positional arguments, ready to spread into the handler. */
  data: unknown[] | null;
  /** Human-readable summary, or null when `ok`. */
  error: string | null;
}

/** How many issues to name before giving up; a wall of them helps nobody. */
const MAX_REPORTED_ISSUES = 6;

interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
}

/** `arg0.sending.perDay`, `arg1[3]`, or `arguments` for a whole-tuple problem. */
function describePath(path: PropertyKey[]): string {
  if (path.length === 0) return 'arguments';
  const [head, ...rest] = path;
  const base = typeof head === 'number' ? `arg${head}` : String(head);
  return (
    base +
    rest.map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('')
  );
}

function summarise(channel: string, issues: readonly ZodIssueLike[]): string {
  const parts = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${describePath(issue.path)}: ${issue.message}`);
  if (issues.length > MAX_REPORTED_ISSUES) {
    parts.push(`…and ${issues.length - MAX_REPORTED_ISSUES} more`);
  }
  return `Invalid arguments for "${channel}" — ${parts.join('; ')}`;
}

/**
 * Parse a raw argument list for a channel.
 *
 * Short argument lists are padded with `undefined` up to the tuple's arity so a
 * caller that omits an optional trailing argument still gets defaults applied,
 * and one that omits a *required* argument gets an issue at the right index
 * rather than an opaque "expected array to have >=2 items".
 */
export function validateChannel(channel: string, args: unknown): ChannelValidation {
  if (!isChannelName(channel)) {
    return { ok: false, data: null, error: `Unknown IPC channel: ${channel}` };
  }
  if (!Array.isArray(args)) {
    return { ok: false, data: null, error: `Invalid arguments for "${channel}" — arguments: expected an array` };
  }

  const arity = channelArity(channel);
  if (args.length > arity) {
    return {
      ok: false,
      data: null,
      error: `Invalid arguments for "${channel}" — arguments: expected at most ${arity} argument${
        arity === 1 ? '' : 's'
      }, received ${args.length}`,
    };
  }

  const padded = args.length === arity ? args : [...args, ...Array<undefined>(arity - args.length).fill(undefined)];
  const result = Schemas[channel].safeParse(padded);
  if (!result.success) {
    return { ok: false, data: null, error: summarise(channel, result.error.issues as ZodIssueLike[]) };
  }
  return { ok: true, data: result.data as unknown[], error: null };
}

let cachedIpcMain: IpcMain | null = null;

function ipc(): IpcMain {
  if (!cachedIpcMain) {
    // Resolved on first registration, which only ever happens inside Electron.
    cachedIpcMain = (require('electron') as typeof import('electron')).ipcMain;
  }
  return cachedIpcMain;
}

/**
 * Register a validated handler. `channel` must exist in `Schemas`; an unknown
 * name throws at registration time so a typo fails at startup rather than
 * silently producing a channel that always rejects.
 */
export function handle<T>(channel: string, fn: (...args: any[]) => Promise<T>): void {
  if (!isChannelName(channel)) {
    throw new Error(`No input schema registered for IPC channel "${channel}"`);
  }
  const name: ChannelName = channel;

  // The dev watcher re-enters registration; ipcMain.handle throws on duplicates.
  ipc().removeHandler(name);
  ipc().handle(name, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const parsed = validateChannel(name, args);
    if (!parsed.ok || !parsed.data) throw new Error(parsed.error ?? `Invalid arguments for "${name}"`);
    return fn(...parsed.data);
  });
}
