/**
 * Runtime validation for every IPC input.
 *
 * The renderer is sandboxed but not trusted: a bug in a mutation hook, a stale
 * cached payload after an upgrade, or anything that ever gets the ability to run
 * script in the window can call `window.api.*` with whatever it likes. Several
 * handlers feed their arguments straight into SQL identifiers, file paths, the
 * scoring engine, or CHECK-constrained columns, where bad input surfaces as a
 * SQLITE_CONSTRAINT stack trace rather than something the operator can act on.
 *
 * Two rules govern the shapes below:
 *
 *  1. Enums must match the CHECK constraints in src/main/db/schema.sql exactly.
 *     A superset means a constraint violation at write time; a subset means the
 *     operator is locked out of a legal value. Both are worse than the boundary
 *     rejecting it here with a readable message.
 *  2. Coercion is only applied where the existing handler already coerced (row
 *     ids). Everything else is checked strictly, so a `headcount` of "50" is a
 *     rejected renderer bug rather than a silently repaired one.
 *
 * Unknown object keys are stripped rather than rejected — that is the point of
 * validating before the handler loops over `Object.entries(patch)`.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** ULID-ish: what `ulid()` in src/main/db/index.ts emits, plus room for imports. */
export const idSchema = z
  .string()
  .min(1, 'Id cannot be empty')
  .max(64, 'Id is too long')
  .refine((s) => !CONTROL_CHARS.test(s), 'Id contains control characters');

/** A row id for the INTEGER PRIMARY KEY tables (suppression, field_observation). */
export const rowIdSchema = z.coerce
  .number()
  .int('Row id must be a whole number')
  .min(1, 'Row id must be positive')
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Column names arrive from the renderer for conflict resolution. They are bound
 * as parameters, never interpolated, but keeping them to identifier syntax means
 * a typo fails here instead of quietly resolving nothing.
 */
export const fieldNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Not a field name');

const MAX_URL = 2048;
const MAX_EMAIL = 320;
const MAX_NOTES = 20_000;
const MAX_SEARCH = 200;

/** Trimmed free text, with '' collapsing to NULL so clearing a field works. */
function nullableText(max: number) {
  return z
    .union([z.null(), z.string().max(max, `Must be at most ${max} characters`)])
    .transform((v) => {
      if (v == null) return null;
      const s = v.trim();
      return s === '' ? null : s;
    });
}

/**
 * Operators type "example.com" as often as they paste a full URL, so a missing
 * scheme is normalised rather than rejected. Anything that is not http(s) after
 * that — file:, javascript:, a bare word — is a hard failure.
 */
export function normaliseUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;
  return parsed.toString();
}

function nullableUrl() {
  return z
    .union([z.null(), z.string().max(MAX_URL, 'URL is too long')])
    .refine((v) => v == null || v.trim() === '' || normaliseUrl(v) !== null, 'Must be an http(s) URL')
    .transform((v) => (v == null ? null : normaliseUrl(v)));
}

const emailFormat = z.email();

function nullableEmail() {
  return z
    .union([z.null(), z.string().max(MAX_EMAIL, 'Email address is too long')])
    .refine(
      (v) => v == null || v.trim() === '' || emailFormat.safeParse(v.trim().toLowerCase()).success,
      'Must be a valid email address',
    )
    .transform((v) => {
      const s = (v ?? '').trim().toLowerCase();
      return s === '' ? null : s;
    });
}

function nullableInt(min: number, max: number) {
  return z.union([
    z.null(),
    z
      .number()
      .int('Must be a whole number')
      .min(min, `Must be at least ${min}`)
      .max(max, `Must be at most ${max}`),
  ]);
}

/** Full http(s) URL, no normalisation — this one is handed to the OS. */
export const externalUrlSchema = z
  .string()
  .max(MAX_URL, 'URL is too long')
  .refine((s) => /^https?:\/\//i.test(s), 'Only http and https links can be opened externally')
  .refine((s) => !CONTROL_CHARS.test(s), 'URL contains control characters')
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Not a valid URL');

/** Confined to <dataDir>/blobs by the handler; rejected here before it gets there. */
export const relPathSchema = z
  .string()
  .min(1, 'Path cannot be empty')
  .max(512, 'Path is too long')
  .refine((p) => !CONTROL_CHARS.test(p), 'Path contains control characters')
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), 'Path must be relative')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'Path must not traverse upward');

// ─────────────────────────────────────────────────────────────────────────────
// Enums. Every one of these mirrors either a CHECK constraint in schema.sql or
// a union in src/shared/types.ts. Keep them in the same order as the source.
// ─────────────────────────────────────────────────────────────────────────────

/** schema.sql: company.status CHECK */
export const companyStatusSchema = z.enum([
  'discovered',
  'enriched',
  'scored',
  'approved',
  'rejected',
  'suppressed',
]);

/** schema.sql: contact.status CHECK */
export const contactStatusSchema = z.enum([
  'candidate',
  'approved',
  'rejected',
  'contacted',
  'replied',
  'bounced',
]);

/** types.ts: Persona */
export const personaSchema = z.enum([
  'founder_ceo',
  'cto_vpe',
  'head_of_talent',
  'recruiter',
  'hiring_manager',
  'coo_ops',
  'other',
]);

/** schema.sql: draft.state CHECK */
export const draftStateSchema = z.enum(['draft', 'queued', 'sending', 'sent', 'failed', 'skipped']);

/** schema.sql: suppression.kind CHECK */
export const suppressionKindSchema = z.enum(['domain', 'email', 'company']);

/** schema.sql: suppression.reason CHECK */
export const suppressionReasonSchema = z.enum([
  'existing_client',
  'active_contract',
  'past_rejection',
  'placed_candidate_employer',
  'competitor',
  'no_agency_policy',
  'replied_no',
  'bounced',
  'manual',
  'opt_out',
]);

/** ipc.ts: SourceKey, plus the LinkedIn URL discovery pass. */
export const sourceKeySchema = z.enum([
  'yc',
  'ats_sweep',
  'careers_crawl',
  'hn_whoishiring',
  'sec_formd',
  'linkedin',
  'linkedin_urls',
  'contact_discovery',
  'email_verify',
  'scoring',
  'draft_generation',
]);

export const companyFilterSchema = z.enum(['all', 'unreviewed', 'conflicts', 'approved', 'rejected']);

export const companySortSchema = z.enum(['score', 'reqs', 'days_open', 'recent', 'name', 'fee']);

export const inboundActionSchema = z.enum(['positive', 'negative', 'bounce', 'ignore']);

export const exportWhatSchema = z.enum(['companies', 'contacts', 'drafts']);

export const testKeyWhichSchema = z.enum(['verifier', 'anthropic']);

export const verifierProviderSchema = z.enum(['reoon', 'bouncer', 'millionverifier', 'none']);

// ─────────────────────────────────────────────────────────────────────────────
// Query + patch payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `limit` tops out at 1,000,000 because the renderer deliberately asks for the
 * whole list in one call (see LIST_PARAMS in src/renderer/lib/api.ts) — the
 * cap exists to stop an absurd value, not to page.
 */
export const companyListParamsSchema = z.object({
  filter: companyFilterSchema.optional(),
  search: z
    .string()
    .max(MAX_SEARCH, `Search is limited to ${MAX_SEARCH} characters`)
    .refine((s) => !CONTROL_CHARS.test(s), 'Search contains control characters')
    .optional(),
  sort: companySortSchema.optional(),
  hasVerifiedEmail: z.boolean().optional(),
  noInhouseTa: z.boolean().optional(),
  staleOnly: z.boolean().optional(),
  limit: z.number().int('limit must be a whole number').min(0, 'limit cannot be negative').max(1_000_000).optional(),
  offset: z.number().int('offset must be a whole number').min(0, 'offset cannot be negative').max(1_000_000).optional(),
});

export const companyPatchSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(200).optional(),
  domain: nullableText(253).optional(),
  headcount: nullableInt(0, 10_000_000).optional(),
  industry: nullableText(200).optional(),
  website: nullableUrl().optional(),
  careersUrl: nullableUrl().optional(),
  linkedinUrl: nullableUrl().optional(),
  hqLocation: nullableText(200).optional(),
  fundingStage: nullableText(100).optional(),
  recruiterCount: nullableInt(0, 100_000).optional(),
  hasInhouseTa: z.union([z.null(), z.boolean()]).optional(),
  notes: nullableText(MAX_NOTES).optional(),
  status: companyStatusSchema.optional(),
  reviewed: z.boolean().optional(),
});

export const contactPatchSchema = z.object({
  fullName: z.string().trim().min(1, 'A contact needs a name').max(200).optional(),
  firstName: nullableText(100).optional(),
  lastName: nullableText(100).optional(),
  title: nullableText(200).optional(),
  persona: z.union([z.null(), personaSchema]).optional(),
  email: nullableEmail().optional(),
  phone: nullableText(64).optional(),
  linkedinUrl: nullableUrl().optional(),
  isPrimary: z.boolean().optional(),
  status: contactStatusSchema.optional(),
  reviewed: z.boolean().optional(),
  notes: nullableText(MAX_NOTES).optional(),
});

export const draftPatchSchema = z.object({
  subject: z.string().max(998, 'Subject is too long for one header line').optional(),
  body: z.string().max(200_000, 'Body is too long').optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

const clockSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a 24-hour HH:MM time');

export const icpPatchSchema = z
  .object({
    minHeadcount: z.number().int().min(0).max(1_000_000).optional(),
    maxHeadcount: z.number().int().min(1).max(1_000_000).optional(),
    maxInhouseRecruiters: z.number().int().min(0).max(500).optional(),
    staleDays: z.number().int().min(1).max(3650).optional(),
    excludedKeywords: z.array(z.string().max(100)).max(500).optional(),
    requireBayArea: z.boolean().optional(),
  })
  .refine(
    (v) => v.minHeadcount === undefined || v.maxHeadcount === undefined || v.minHeadcount <= v.maxHeadcount,
    'minHeadcount cannot exceed maxHeadcount',
  );

/**
 * perDay is capped at 500 because that is Gmail's hard daily ceiling for a
 * consumer/Workspace account — a higher number cannot be honoured, it can only
 * get the mailbox rate-limited mid-run.
 */
export const sendingPatchSchema = z.object({
  perHour: z.number().int().min(1, 'perHour must be at least 1').max(200, 'perHour cannot exceed 200').optional(),
  perDay: z
    .number()
    .int()
    .min(1, 'perDay must be at least 1')
    .max(500, "perDay cannot exceed 500 — that is Gmail's hard daily ceiling")
    .optional(),
  windowStart: clockSchema.optional(),
  windowEnd: clockSchema.optional(),
  jitterPct: z.number().int().min(0, 'jitterPct cannot be negative').max(100, 'jitterPct cannot exceed 100').optional(),
  weekends: z.boolean().optional(),
  signature: z.string().max(2000, 'Signature is too long').optional(),
  includeOptOutLine: z.boolean().optional(),
});

export const crawlPatchSchema = z.object({
  concurrency: z
    .number()
    .int()
    .min(1, 'concurrency must be at least 1')
    .max(32, 'concurrency cannot exceed 32')
    .optional(),
  linkedinPerDay: z
    .number()
    .int()
    .min(0, 'linkedinPerDay cannot be negative')
    .max(200, 'linkedinPerDay cannot exceed 200')
    .optional(),
  linkedinEnabled: z.boolean().optional(),
});

export const settingsPatchSchema = z.object({
  icp: icpPatchSchema.optional(),
  sending: sendingPatchSchema.optional(),
  crawl: crawlPatchSchema.optional(),
  spendCapUsd: z.number().min(0, 'spendCapUsd cannot be negative').max(1_000_000).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Remaining scalar payloads
// ─────────────────────────────────────────────────────────────────────────────

/** Normalised by normaliseSecretKey() in src/main/settings.ts; keep it filename-safe. */
export const secretKeySchema = z
  .string()
  .min(1, 'Secret key cannot be empty')
  .max(64, 'Secret key is too long')
  .regex(/^[A-Za-z0-9_.-]+$/, 'Secret key may only contain letters, digits, dot, dash and underscore');

/** Empty is legal — that is how the operator clears a saved key. */
export const secretValueSchema = z.string().max(8192, 'Secret value is too long');

export const suppressionValueSchema = z
  .string()
  .min(1, 'Suppression value cannot be empty')
  .max(320, 'Suppression value is too long')
  .refine((s) => !CONTROL_CHARS.test(s), 'Suppression value contains control characters');

export const suppressionNoteSchema = z.string().max(2000, 'Note is too long');

export const csvSchema = z.string().max(5_000_000, 'CSV is too large to import in one call');

// ─────────────────────────────────────────────────────────────────────────────
// Channel map. One tuple per RecruitApi method, because handlers take positional
// arguments. Channels that take nothing map to an empty tuple, which also means
// junk arguments on them are rejected rather than ignored.
// ─────────────────────────────────────────────────────────────────────────────

export const Schemas = {
  // companies
  listCompanies: z.tuple([companyListParamsSchema.default({})]),
  getCompany: z.tuple([idSchema]),
  patchCompany: z.tuple([idSchema, companyPatchSchema.default({})]),
  bulkCompanyStatus: z.tuple([z.array(idSchema).max(100_000, 'Too many ids in one call'), companyStatusSchema]),
  resolveConflict: z.tuple([idSchema, fieldNameSchema, rowIdSchema]),

  // contacts
  patchContact: z.tuple([idSchema, contactPatchSchema.default({})]),
  addContact: z.tuple([idSchema, contactPatchSchema.default({})]),
  deleteContact: z.tuple([idSchema]),
  findContacts: z.tuple([idSchema]),
  verifyContact: z.tuple([idSchema]),

  // pipeline
  getPipeline: z.tuple([]),
  runSource: z.tuple([sourceKeySchema]),
  runAll: z.tuple([]),
  stopPipeline: z.tuple([]),
  setSourceEnabled: z.tuple([sourceKeySchema, z.boolean()]),

  // outreach
  listDrafts: z.tuple([draftStateSchema.optional()]),
  generateDraft: z.tuple([idSchema, idSchema.optional()]),
  patchDraft: z.tuple([idSchema, draftPatchSchema.default({})]),
  queueDraft: z.tuple([idSchema]),
  skipDraft: z.tuple([idSchema]),
  sendNow: z.tuple([idSchema]),
  getSendStats: z.tuple([]),
  startSending: z.tuple([]),
  pauseSending: z.tuple([]),
  listInbound: z.tuple([z.boolean().optional()]),
  markInbound: z.tuple([idSchema, inboundActionSchema]),
  syncInbox: z.tuple([]),

  // settings
  getSettings: z.tuple([]),
  patchSettings: z.tuple([settingsPatchSchema.default({})]),
  setSecret: z.tuple([secretKeySchema, secretValueSchema]),
  testKey: z.tuple([testKeyWhichSchema]),
  connectGmail: z.tuple([]),
  disconnectGmail: z.tuple([]),
  testGmail: z.tuple([]),

  // linkedin
  getLinkedInStatus: z.tuple([]),
  connectLinkedIn: z.tuple([]),
  disconnectLinkedIn: z.tuple([]),

  // suppression
  listSuppressions: z.tuple([]),
  addSuppression: z.tuple([
    suppressionKindSchema,
    suppressionValueSchema,
    suppressionReasonSchema,
    suppressionNoteSchema.optional(),
  ]),
  removeSuppression: z.tuple([rowIdSchema]),
  importSuppressionsCsv: z.tuple([csvSchema]),

  // misc
  getStats: z.tuple([]),
  exportCsv: z.tuple([exportWhatSchema]),
  backupNow: z.tuple([]),
  openDataDir: z.tuple([]),
  openExternal: z.tuple([externalUrlSchema]),
  getScreenshot: z.tuple([relPathSchema]),
};

export type ChannelName = keyof typeof Schemas;

export const CHANNEL_NAMES = Object.keys(Schemas) as ChannelName[];

export function isChannelName(channel: string): channel is ChannelName {
  return Object.prototype.hasOwnProperty.call(Schemas, channel);
}

/**
 * How many positional arguments a channel declares.
 *
 * The guard pads a short argument list out to this length before parsing, so a
 * missing trailing argument becomes a normal "expected X, received undefined"
 * issue at the right path and `.default()` on a trailing patch still applies.
 */
export function channelArity(channel: string): number {
  if (!isChannelName(channel)) return 0;
  return (Schemas[channel] as unknown as { def: { items: readonly unknown[] } }).def.items.length;
}
