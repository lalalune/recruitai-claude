/**
 * Turning an error into a log line without writing a live credential to it.
 *
 * Google's client libraries attach the entire request to the error they throw:
 * gaxios sets `err.config` (url, method, headers) and `err.response`. Node's
 * console prints an Error's own enumerable properties alongside the stack, so
 * `console.warn('...', err)` publishes both of the credentials those objects
 * carry — `Authorization: Bearer <access token>` on every API call, and the
 * refresh token itself in the query string of the revoke endpoint
 * (google-auth-library builds `.../revoke?token=<refresh token>`).
 *
 * Everything logged from the Gmail modules therefore goes through here.
 */

import { inspect } from 'node:util';

const CREDENTIAL_NAMES =
  'token|access_token|refresh_token|id_token|client_secret|code_verifier|assertion|api[-_]?key|x-api-key|password';

const RULES: readonly [RegExp, string][] = [
  // `Authorization: Bearer ya29…`, in a header object or a raw header line.
  [/\b(bearer)\s+[\w.~+/-]+=*/gi, '$1 [redacted]'],
  // `?token=…` / `&client_secret=…`. `code` belongs here and only here: an
  // OAuth authorization code is a credential in a query string, while
  // "code: invalid_grant" is the diagnostic the reader came for.
  [new RegExp(`([?&](?:${CREDENTIAL_NAMES}|code)=)[^&\\s'"\`]+`, 'gi'), '$1[redacted]'],
  // `refresh_token: 'x'`, `"client_secret":"x"`, `x-api-key: 'x'`
  [
    new RegExp(`(['"\`]?(?:${CREDENTIAL_NAMES})['"\`]?\\s*[:=]\\s*['"\`]?)[\\w.~+/-]{4,}=*`, 'gi'),
    '$1[redacted]',
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * A printable, redacted rendering of anything thrown. `inspect` rather than
 * `String(err)` on purpose: the useful diagnostic (HTTP status, endpoint) lives
 * in those attached properties, and dropping them wholesale would trade a
 * secret leak for an unactionable log line.
 */
export function redactError(err: unknown): string {
  const text =
    typeof err === 'string'
      ? err
      : inspect(err, { depth: 2, breakLength: 120, maxStringLength: 512, maxArrayLength: 20 });
  return redactSecrets(text);
}
