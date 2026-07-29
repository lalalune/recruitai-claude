/**
 * Gmail integration — public surface.
 *
 * The IPC layer, the send queue and the settings screen should import from here
 * and nowhere deeper. Everything below is either an implementation detail or a
 * seam that only exists for tests.
 *
 * OPERATOR SETUP, once, in Google Cloud Console:
 *   1. Create a project and enable the Gmail API.
 *   2. OAuth consent screen → External → add yourself as the sole user.
 *   3. PUBLISH the app to "In production". Leave it unverified — Google's
 *      personal-use exemption covers an app whose only user is its author.
 *      Skipping this leaves the app in "Testing", where refresh tokens expire
 *      after 7 days and you will be reconnecting every week.
 *   4. Credentials → OAuth client ID → Application type "Desktop app".
 *   5. Paste the client ID and client secret into Settings → Gmail (or set
 *      RECRUITAI_GMAIL_CLIENT_ID / RECRUITAI_GMAIL_CLIENT_SECRET).
 *   No redirect URI needs registering: the Desktop client type accepts any
 *   127.0.0.1 port, which is what the loopback + PKCE flow relies on.
 */

export {
  // connection lifecycle
  connectGmail,
  disconnectGmail,
  isConnected,
  getAddress,
  testConnection,
  needsReauth,
  markNeedsReauth,
  // client credentials
  getClientCredentials,
  KEY_CLIENT_ID,
  KEY_CLIENT_SECRET,
  KEY_REFRESH_TOKEN,
  KEY_ADDRESS,
  KEY_HISTORY_ID,
  KEY_NEEDS_REAUTH,
  KEY_CONNECTED_AT,
  CLIENT_SETUP_MESSAGE,
  GMAIL_SCOPES,
  // secret storage (safeStorage-backed); shared with the API-key settings screen
  getSecret,
  setSecret,
  deleteSecret,
  encryptionAvailable,
  getSetting,
  setSetting,
  // events
  setGmailEventSink,
  // low-level clients, for anything this module does not already wrap
  getAuthClient,
  getGmailClient,
  gmailCall,
  classifyGmailError,
  // errors
  GmailAuthError,
  GmailQuotaError,
  GmailApiError,
  type ConnectResult,
  type ConnectionTest,
  type ClientCredentials,
} from './oauth.js';

export {
  sendMessage,
  sendTestMessage,
  assertNotSuppressed,
  isPlausibleAddress,
  SuppressedRecipientError,
  OUTBOUND_SEND_ID_HEADER,
  type SendRequest,
  type SendResult,
} from './send.js';

export { syncInbox } from './inbox.js';

export {
  SEND_ID_HEADER,
  buildRawMessage,
  parseDeliveryStatus,
  parseHeaderBlock,
  parseContentType,
  extractAddress,
  extractMessageId,
  extractMessageIds,
  headerValue,
  type OutboundMessage,
  type DeliveryStatusRecipient,
} from './mime.js';


export interface GmailStatus {
  connected: boolean;
  address: string | null;
  needsReauth: boolean;
}

// (A getGmailStatus helper lived here shaped for Settings.gmail; the settings
// module composes that block itself from isConnected/getAddress/needsReauth,
// so the duplicate — with subtly different disconnected-address semantics —
// was removed rather than left to drift.)
