/**
 * Gmail OAuth — loopback + PKCE, tokens sealed with Electron safeStorage.
 *
 * Two facts drive the shape of this file:
 *
 *  1. The out-of-band flow (urn:ietf:wg:oauth:2.0:oob) is dead. Google's
 *     "Desktop app" client type wildcards the loopback PORT, so we can bind an
 *     ephemeral port at 127.0.0.1, use it in redirect_uri, and never register
 *     anything. PKCE S256 is what makes that safe without a confidential secret.
 *
 *  2. OPERATOR SETUP NOTE — refresh tokens issued by an OAuth app in "Testing"
 *     publishing status expire after 7 days. Push the Cloud Console consent
 *     screen to "In production". It can stay UNVERIFIED: Google's personal-use
 *     exemption covers an app whose only user is its author, so no verification
 *     and no CASA assessment is required, and the 7-day expiry goes away.
 *     Skipping this step means re-authorising every week. The NEEDS_REAUTH path
 *     below exists as insurance, not as a substitute for doing it.
 */

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { gmail, gmail_v1 } from '@googleapis/gmail';
import { getDb, prep } from '../db/index.js';
import type { EventName, RecruitEvents } from '../../shared/ipc.js';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

/** Setting keys owned by this module. Namespaced so the settings UI can't collide. */
export const KEY_REFRESH_TOKEN = 'gmail.refresh_token';
export const KEY_CLIENT_ID = 'gmail.client_id';
export const KEY_CLIENT_SECRET = 'gmail.client_secret';
export const KEY_ADDRESS = 'gmail.address';
export const KEY_HISTORY_ID = 'gmail.history_id';
export const KEY_NEEDS_REAUTH = 'gmail.needs_reauth';
export const KEY_CONNECTED_AT = 'gmail.connected_at';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Errors. The send queue and the pipeline runner branch on these, so they are
// classes rather than string matching on a message.
// ─────────────────────────────────────────────────────────────────────────────

/** Credentials are gone or revoked. Only the operator can fix it. */
export class GmailAuthError extends Error {
  readonly needsReauth = true;
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

/**
 * Google told us to slow down or stop for the day. Terminal for this run —
 * callers must pause the queue and surface it, never spin on a retry loop.
 */
export class GmailQuotaError extends Error {
  readonly retryable = false;
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GmailQuotaError';
  }
}

/** Anything else the API rejected. */
export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron access. Loaded lazily and tolerantly so this module can also be
// imported from the worker process, which has no electron binding at all.
// ─────────────────────────────────────────────────────────────────────────────

type ElectronModule = typeof import('electron');
let electronCache: ElectronModule | null | undefined;

async function electron(): Promise<ElectronModule | null> {
  if (electronCache !== undefined) return electronCache;
  try {
    electronCache = (await import('electron')) as ElectronModule;
    if (!electronCache?.app) electronCache = null;
  } catch {
    electronCache = null;
  }
  return electronCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events. A sink can be installed by whoever wires IPC; failing that we push
// straight to every renderer so the reauth banner still appears.
// ─────────────────────────────────────────────────────────────────────────────

type EventSink = <K extends EventName>(channel: K, payload: RecruitEvents[K]) => void;

let sink: EventSink | null = null;

export function setGmailEventSink(fn: EventSink | null): void {
  sink = fn;
}

export function emitGmailEvent<K extends EventName>(channel: K, payload: RecruitEvents[K]): void {
  try {
    sink?.(channel, payload);
  } catch (err) {
    console.warn('[gmail] event sink threw:', err);
  }
  void (async () => {
    const e = await electron();
    if (!e) return;
    for (const win of e.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  })().catch(() => {
    /* renderer may be gone; the sink already fired */
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret + setting storage
//
// safeStorage is OS-keychain backed on macOS and Windows. Some Linux desktops
// have no keyring at all, in which case Electron degrades to a no-op cipher —
// we refuse to pretend and store marked plaintext with a loud warning instead,
// because silently "encrypted" data that isn't is worse than an honest warning.
// ─────────────────────────────────────────────────────────────────────────────

const ENC_PREFIX = 'enc:v1:';
const RAW_PREFIX = 'raw:v1:';
let warnedAboutPlaintext = false;

async function encryptionAvailable(): Promise<boolean> {
  const e = await electron();
  if (!e?.safeStorage) return false;
  try {
    return e.safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function setSecret(key: string, value: string): Promise<void> {
  const e = await electron();
  let stored: string;

  if (await encryptionAvailable()) {
    stored = ENC_PREFIX + e!.safeStorage.encryptString(value).toString('base64');
  } else {
    if (!warnedAboutPlaintext) {
      warnedAboutPlaintext = true;
      console.warn(
        '[gmail] WARNING: OS encryption (safeStorage) is unavailable on this system.\n' +
          '        Secrets including the Gmail refresh token are being stored as PLAINTEXT\n' +
          '        in the local database. Install a system keyring (gnome-keyring / kwallet)\n' +
          '        and reconnect to fix this.',
      );
    }
    stored = RAW_PREFIX + value;
  }

  prep(
    getDb(),
    `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = 1, updated_at = excluded.updated_at`,
  ).run(key, stored, Date.now());
}

export async function getSecret(key: string): Promise<string | null> {
  const row = prep(getDb(), 'SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;

  if (row.value.startsWith(RAW_PREFIX)) return row.value.slice(RAW_PREFIX.length);
  if (!row.value.startsWith(ENC_PREFIX)) return row.value; // written before this module existed

  const e = await electron();
  if (!e?.safeStorage) return null;
  try {
    return e.safeStorage.decryptString(Buffer.from(row.value.slice(ENC_PREFIX.length), 'base64'));
  } catch (err) {
    // Happens when the OS keychain entry was wiped or the profile moved machines.
    console.warn(`[gmail] could not decrypt secret "${key}": ${String(err)}`);
    return null;
  }
}

export function deleteSecret(key: string): void {
  prep(getDb(), 'DELETE FROM setting WHERE key = ?').run(key);
}

export function getSetting(key: string): string | null {
  const row = prep(getDb(), 'SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  prep(
    getDb(),
    `INSERT INTO setting (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

// ─────────────────────────────────────────────────────────────────────────────
// Client credentials
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * A Desktop-app client secret is not actually confidential (Google's own docs
 * say so, which is precisely why PKCE is mandatory here), but it still lives in
 * the secret store so it never lands in a plaintext export or a screenshot.
 */
export async function getClientCredentials(): Promise<ClientCredentials | null> {
  const clientId = process.env.RECRUITAI_GMAIL_CLIENT_ID || (await getSecret(KEY_CLIENT_ID));
  const clientSecret =
    process.env.RECRUITAI_GMAIL_CLIENT_SECRET || (await getSecret(KEY_CLIENT_SECRET));
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export const CLIENT_SETUP_MESSAGE =
  'No Google OAuth client configured. In Google Cloud Console create an OAuth 2.0 ' +
  'Client ID of type "Desktop app", publish the consent screen to "In production" ' +
  '(it does not need verification for personal use), then paste the client ID and ' +
  'secret into Settings → Gmail.';

// ─────────────────────────────────────────────────────────────────────────────
// Connection state
// ─────────────────────────────────────────────────────────────────────────────

export async function isConnected(): Promise<boolean> {
  return (await getSecret(KEY_REFRESH_TOKEN)) !== null;
}

export function getAddress(): string | null {
  return getSetting(KEY_ADDRESS);
}

export function needsReauth(): boolean {
  return getSetting(KEY_NEEDS_REAUTH) === '1';
}

function clearReauthFlag(): void {
  setSetting(KEY_NEEDS_REAUTH, '0');
}

/** Idempotent: only fires the renderer event on the 0 → 1 transition. */
export function markNeedsReauth(reason: string): void {
  const already = needsReauth();
  setSetting(KEY_NEEDS_REAUTH, '1');
  if (already) return;
  console.warn(`[gmail] credentials rejected (${reason}); reauthorisation required`);
  emitGmailEvent('gmail:needs-reauth', { address: getAddress() });
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification. googleapis surfaces gaxios errors whose useful detail is
// buried a few levels down and differs between the token endpoint and the API.
// ─────────────────────────────────────────────────────────────────────────────

interface GaxiosLike {
  message?: string;
  code?: string | number;
  status?: number;
  response?: {
    status?: number;
    data?: {
      error?: string | { message?: string; errors?: { reason?: string; message?: string }[] };
      error_description?: string;
    };
  };
}

export function classifyGmailError(err: unknown): Error {
  const g = err as GaxiosLike;
  const data = g?.response?.data;
  const status = g?.response?.status ?? g?.status ?? (typeof g?.code === 'number' ? g.code : 0);

  let reason = '';
  let message = g?.message ?? String(err);

  if (typeof data?.error === 'string') {
    reason = data.error;
    if (data.error_description) message = `${data.error}: ${data.error_description}`;
  } else if (data?.error && typeof data.error === 'object') {
    reason = data.error.errors?.[0]?.reason ?? '';
    message = data.error.message ?? message;
  }

  const blob = `${reason} ${message}`.toLowerCase();

  if (
    reason === 'invalid_grant' ||
    status === 401 ||
    blob.includes('invalid credentials') ||
    blob.includes('token has been expired or revoked')
  ) {
    return new GmailAuthError(message || 'Gmail credentials are no longer valid.');
  }

  // 403 with a quota reason is a limit, not a block. A 403 without one means the
  // scope was never granted, which is an auth problem.
  const quotaReasons = [
    'ratelimitexceeded',
    'userratelimitexceeded',
    'quotaexceeded',
    'dailylimitexceeded',
  ];
  if (
    status === 429 ||
    quotaReasons.includes(reason.toLowerCase()) ||
    blob.includes('daily limit exceeded') ||
    blob.includes('user-rate limit exceeded')
  ) {
    return new GmailQuotaError(
      message || 'Gmail rate/quota limit reached.',
      status || 429,
      reason || 'rateLimitExceeded',
    );
  }

  if (status === 403 && (blob.includes('insufficient') || blob.includes('scope'))) {
    return new GmailAuthError(message || 'Gmail scope missing; reconnect to grant it.');
  }

  return new GmailApiError(message, status, reason);
}

/**
 * Single funnel for every Gmail API call. Converts the error, and flips the
 * reauth flag as a side effect so no call site can forget to.
 */
export async function gmailCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    if (needsReauth()) clearReauthFlag();
    return out;
  } catch (err) {
    const converted = classifyGmailError(err);
    if (converted instanceof GmailAuthError) markNeedsReauth(converted.message);
    throw converted;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated clients
// ─────────────────────────────────────────────────────────────────────────────

let cachedClient: OAuth2Client | null = null;
let cachedClientId = '';

export async function getAuthClient(): Promise<OAuth2Client> {
  const creds = await getClientCredentials();
  if (!creds) throw new GmailAuthError(CLIENT_SETUP_MESSAGE);

  const refreshToken = await getSecret(KEY_REFRESH_TOKEN);
  if (!refreshToken) throw new GmailAuthError('Gmail is not connected.');

  if (cachedClient && cachedClientId === creds.clientId) {
    if (cachedClient.credentials.refresh_token === refreshToken) return cachedClient;
  }

  const client = new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  client.setCredentials({ refresh_token: refreshToken });

  // Google occasionally rotates the refresh token on a refresh. Dropping the new
  // one silently strands the connection days later, so persist every one we see.
  client.on('tokens', (tokens) => {
    if (!tokens.refresh_token || tokens.refresh_token === refreshToken) return;
    void setSecret(KEY_REFRESH_TOKEN, tokens.refresh_token).catch((err) =>
      console.warn('[gmail] failed to persist rotated refresh token:', err),
    );
  });

  cachedClient = client;
  cachedClientId = creds.clientId;
  return client;
}

/**
 * npm resolves a second, older copy of google-auth-library underneath
 * googleapis-common, so the two OAuth2Client classes are structurally identical
 * but nominally distinct to TypeScript (they each declare a private field). One
 * cast at this single seam is the whole cost of that; the runtime object is the
 * same shape either way.
 */
type GmailAuth = NonNullable<gmail_v1.Options['auth']>;

export function gmailForClient(client: OAuth2Client): gmail_v1.Gmail {
  return gmail({ version: 'v1', auth: client as unknown as GmailAuth });
}

export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  return gmailForClient(await getAuthClient());
}

function resetClientCache(): void {
  cachedClient = null;
  cachedClientId = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// The loopback authorisation flow
// ─────────────────────────────────────────────────────────────────────────────

interface CallbackResult {
  code?: string;
  error?: string;
}

/**
 * Binds port 0, reads the port the OS actually gave us, and only then builds the
 * redirect URI. This is what makes "no pre-registered port" work: the Desktop
 * client type treats any 127.0.0.1 port as a valid loopback redirect.
 */
function startLoopbackServer(expectedState: string): {
  port: Promise<number>;
  result: Promise<CallbackResult>;
  close: () => void;
} {
  let resolvePort!: (p: number) => void;
  let rejectPort!: (e: Error) => void;
  let resolveResult!: (r: CallbackResult) => void;
  let rejectResult!: (e: Error) => void;

  const port = new Promise<number>((res, rej) => {
    resolvePort = res;
    rejectPort = rej;
  });
  const result = new Promise<CallbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  let settled = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth2callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (!constantTimeEqual(state, expectedState)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('Authorisation failed', 'The state parameter did not match. Nothing was changed.'));
      return;
    }

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('Authorisation cancelled', `Google reported: ${escapeHtml(error)}`));
      if (!settled) {
        settled = true;
        resolveResult({ error });
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(resultPage('Gmail connected', 'You can close this tab and return to recruitAI.'));
    if (!settled) {
      settled = true;
      resolveResult({ code: code ?? undefined });
    }
  });

  server.on('error', (err) => {
    rejectPort(err);
    if (!settled) {
      settled = true;
      rejectResult(err);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo | null;
    if (!addr) {
      rejectPort(new Error('Could not determine loopback port'));
      return;
    }
    resolvePort(addr.port);
  });

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResult(new Error('Timed out waiting for Google authorisation (5 minutes).'));
    }
  }, AUTH_TIMEOUT_MS);
  timer.unref?.();

  return {
    port,
    result,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    },
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function resultPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0c;color:#e7e7e9}
div{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;color:#a1a1aa}</style></head>
<body><div><h1>${escapeHtml(title)}</h1><p>${body}</p></div></body></html>`;
}

export interface ConnectResult {
  ok: boolean;
  address?: string;
  message: string;
}

export async function connectGmail(): Promise<ConnectResult> {
  const creds = await getClientCredentials();
  if (!creds) return { ok: false, message: CLIENT_SETUP_MESSAGE };

  const e = await electron();
  if (!e?.shell) {
    return {
      ok: false,
      message: 'Gmail can only be connected from the desktop app (a browser is needed for consent).',
    };
  }

  const state = randomBytes(24).toString('base64url');
  const server = startLoopbackServer(state);

  try {
    const port = await server.port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

    const client = new OAuth2Client({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri,
    });

    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      // Without this Google omits the refresh token on every consent after the
      // first, and the connection silently works until the access token expires.
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
    });

    await e.shell.openExternal(authUrl);

    const callback = await server.result;
    if (callback.error) {
      return { ok: false, message: `Authorisation was declined (${callback.error}).` };
    }
    if (!callback.code) {
      return { ok: false, message: 'Google did not return an authorisation code.' };
    }

    const { tokens } = await client.getToken({
      code: callback.code,
      codeVerifier,
      redirect_uri: redirectUri,
    });

    if (!tokens.refresh_token) {
      return {
        ok: false,
        message:
          'Google returned no refresh token. Remove recruitAI at ' +
          'myaccount.google.com/permissions and connect again.',
      };
    }

    client.setCredentials(tokens);

    const api = gmailForClient(client);
    const profile = await api.users.getProfile({ userId: 'me' });
    const address = profile.data.emailAddress ?? null;
    const historyId = profile.data.historyId ?? null;

    await setSecret(KEY_REFRESH_TOKEN, tokens.refresh_token);
    if (address) setSetting(KEY_ADDRESS, address);
    // Anchor incremental sync here so the first syncInbox() doesn't have to
    // decide what "recent" means with no prior state.
    if (historyId) setSetting(KEY_HISTORY_ID, historyId);
    setSetting(KEY_CONNECTED_AT, String(Date.now()));
    clearReauthFlag();
    resetClientCache();

    return {
      ok: true,
      address: address ?? undefined,
      message: address ? `Connected as ${address}.` : 'Connected.',
    };
  } catch (err) {
    const converted = classifyGmailError(err);
    return { ok: false, message: converted.message };
  } finally {
    server.close();
  }
}

/**
 * Revokes at Google as well as locally. A local-only disconnect leaves a live
 * grant the operator can't see, which is exactly the kind of thing that turns
 * into a surprise later.
 */
export async function disconnectGmail(): Promise<void> {
  const refreshToken = await getSecret(KEY_REFRESH_TOKEN);
  const creds = await getClientCredentials();

  if (refreshToken && creds) {
    try {
      const client = new OAuth2Client({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });
      await client.revokeToken(refreshToken);
    } catch (err) {
      console.warn('[gmail] token revoke failed (continuing with local disconnect):', err);
    }
  }

  deleteSecret(KEY_REFRESH_TOKEN);
  prep(getDb(), 'DELETE FROM setting WHERE key IN (?, ?, ?, ?)').run(
    KEY_ADDRESS,
    KEY_HISTORY_ID,
    KEY_NEEDS_REAUTH,
    KEY_CONNECTED_AT,
  );
  resetClientCache();
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  address?: string;
  messagesTotal?: number;
  historyId?: string;
}

export async function testConnection(): Promise<ConnectionTest> {
  if (!(await isConnected())) return { ok: false, message: 'Gmail is not connected.' };

  try {
    const api = await getGmailClient();
    const profile = await gmailCall(() => api.users.getProfile({ userId: 'me' }));
    const address = profile.data.emailAddress ?? undefined;
    if (address) setSetting(KEY_ADDRESS, address);

    return {
      ok: true,
      message: `Connected as ${address ?? 'unknown address'}.`,
      address,
      messagesTotal: profile.data.messagesTotal ?? undefined,
      historyId: profile.data.historyId ?? undefined,
    };
  } catch (err) {
    const converted = err instanceof Error ? err : new Error(String(err));
    return {
      ok: false,
      message:
        converted instanceof GmailAuthError
          ? `${converted.message} Reconnect Gmail in Settings.`
          : converted.message,
    };
  }
}
