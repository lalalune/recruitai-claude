/**
 * Outreach copy shared between main and renderer.
 *
 * One opt-out line, one variable-substitution routine, one compliance footer —
 * main uses them to generate and to gate what actually leaves the machine, the
 * renderer uses the very same functions for its preview, so "preview equals
 * sent" holds by construction instead of by parallel re-implementation.
 */

export const HEADCOUNT_BANDS = ['under_20', '20_75', '75_300', 'over_300'] as const;
export type HeadcountBand = (typeof HEADCOUNT_BANDS)[number];

export const BAND_LABELS: Record<HeadcountBand, string> = {
  under_20: 'Under 20 people',
  '20_75': '20–75 people',
  '75_300': '75–300 people',
  over_300: 'Over 300 people',
};

export interface BandTemplate {
  subject: string;
  body: string;
}

export type TemplateBands = Record<HeadcountBand, BandTemplate>;

export const DEFAULT_OPT_OUT_LINE =
  "If this isn't relevant, reply with 'no thanks' and I'll close the file — you won't hear from me again.";

/** The variables an operator may use in a custom template. */
export const TEMPLATE_VARIABLES = [
  'firstName',
  'companyName',
  'reqTitle',
  'reqDaysOpen',
  'reqLocation',
  'openReqCount',
  'openEngCount',
  'staleReqCount',
  'fee',
  'fundingStage',
  'ycBatch',
] as const;

export type TemplateVars = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string | number | null>>;

const VAR_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * Substitute `{variable}` tokens. A line containing a token whose value is
 * missing (null/undefined/'') — or a token we do not know at all — is dropped
 * whole, mirroring the built-in renderers' rule: a missing fact removes the
 * sentence, it never degrades into "open  days".
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const out: string[] = [];
  for (const line of template.split('\n')) {
    let dropped = false;
    const rendered = line.replace(VAR_RE, (_m, name: string) => {
      const v = (vars as Record<string, unknown>)[name];
      if (v === null || v === undefined || v === '') {
        dropped = true;
        return '';
      }
      return String(v);
    });
    if (!dropped) out.push(rendered);
  }
  // Collapse the blank runs that dropped lines leave behind.
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Token names present in a template that are not known variables. */
export function unknownTemplateVariables(template: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  const found = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    if (!known.has(m[1]!)) found.add(m[1]!);
  }
  return [...found].sort();
}

export interface FooterOptions {
  includeOptOutLine: boolean;
  postalAddress: string;
  signature: string;
}

/**
 * The footer every outbound message must carry: signature, a working opt-out
 * instruction, and the sender's postal address (CAN-SPAM requires a valid
 * physical postal address in every commercial message).
 */
export function assembleEmail(body: string, opts: FooterOptions): string {
  const parts = [body.trimEnd()];
  if (opts.includeOptOutLine) parts.push('', DEFAULT_OPT_OUT_LINE);
  if (opts.signature.trim()) parts.push('', opts.signature.trim());
  if (opts.postalAddress.trim()) parts.push('', opts.postalAddress.trim());
  return parts.join('\n');
}

/**
 * Send-time backstop: whatever happened to the draft between generation and
 * send (manual edits included), the message that leaves carries the opt-out
 * line and postal address when they are configured on. The signature is NOT
 * re-appended here — it was baked in at generation and an edit that removed
 * it is the operator's own call.
 */
export function ensureCompliantFooter(
  body: string,
  opts: Pick<FooterOptions, 'includeOptOutLine' | 'postalAddress'>,
): string {
  let out = body.trimEnd();
  // Detection is newline-normalised (a pasted CRLF body must not defeat it)
  // and the postal check is line-anchored — a street name that happens to
  // appear inside prose must not suppress the real footer.
  const normalised = () => out.replace(/\r\n/g, '\n');
  if (opts.includeOptOutLine && !normalised().includes(DEFAULT_OPT_OUT_LINE)) {
    out = `${out}\n\n${DEFAULT_OPT_OUT_LINE}`;
  }
  const postal = opts.postalAddress.trim();
  if (postal) {
    const postalLines = postal.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const bodyLines = new Set(
      normalised()
        .split('\n')
        .map((l) => l.trim()),
    );
    const present = postalLines.every((l) => bodyLines.has(l));
    if (!present) out = `${out}\n\n${postal}`;
  }
  return out;
}
