/**
 * IPC contract between the Electron renderer and main process.
 *
 * Single source of truth for both sides. The renderer calls these through
 * `window.api.<channel>(payload)` (see src/main/preload.ts); main registers a
 * handler per channel in src/main/ipc/.
 */

import type { Persona, VerificationVerdict, AtsPlatform } from './types.js';
import type { ScoreComponent } from './score.js';

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes the UI actually renders (flattened, not the full domain objects)
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  headcount: number | null;
  industry: string | null;
  qualityScore: number | null;
  scoreHeadline: string | null;
  openReqCount: number;
  openReqEngCount: number;
  staleReqCount: number;
  maxDaysOpen: number | null;
  estimatedFeeUsd: number | null;
  hasInhouseTa: boolean | null;
  recruiterCount: number | null;
  contactCount: number;
  verifiedContactCount: number;
  hasConflict: boolean;
  disqualified: string | null;
  status: string;
  reviewed: boolean;
  ycBatch: string | null;
  atsPlatform: AtsPlatform | null;
}

export interface CompanyDetail extends CompanyRow {
  website: string | null;
  careersUrl: string | null;
  linkedinUrl: string | null;
  hqLocation: string | null;
  fundingStage: string | null;
  lastRoundAt: number | null;
  scoreRaw: number | null;
  scoreBreakdown: ScoreComponent[];
  notes: string | null;
  reqs: ReqRow[];
  contacts: ContactRow[];
  fields: ResolvedField[];
  screenshots: ScreenshotRow[];
  createdAt: number;
  updatedAt: number;
}

export interface ReqRow {
  id: number;
  title: string;
  department: string | null;
  team: string | null;
  location: string | null;
  isRemote: boolean | null;
  compMin: number | null;
  compMax: number | null;
  estimatedFeeUsd: number | null;
  daysOpen: number | null;
  repostCount: number;
  url: string;
  publishedAt: number | null;
  closedAt: number | null;
  functionFamily: string | null;
  seniority: string | null;
  noAgencyDisclaimer: boolean | null;
  namedContact: string | null;
  description: string | null;
}

export interface ContactRow {
  id: string;
  companyId: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  persona: Persona | null;
  email: string | null;
  emailVerdict: VerificationVerdict;
  emailVerifiedAt: number | null;
  emailSource: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  isPrimary: boolean;
  contactScore: number | null;
  status: string;
  reviewed: boolean;
  notes: string | null;
}

/** A field with its winning value plus every competing observation. */
export interface ResolvedField {
  field: string;
  value: string | null;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  conflicting: boolean;
  observations: {
    id: number;
    value: string | null;
    source: string;
    confidence: string;
    observedAt: number;
    evidenceId: number | null;
  }[];
}

export interface ScreenshotRow {
  id: string;
  kind: string;
  relPath: string;
  url: string | null;
  width: number | null;
  height: number | null;
  capturedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyFilter = 'all' | 'unreviewed' | 'conflicts' | 'approved' | 'rejected';

export interface CompanyListParams {
  filter?: CompanyFilter;
  search?: string;
  sort?: 'score' | 'reqs' | 'days_open' | 'recent' | 'name' | 'fee';
  hasVerifiedEmail?: boolean;
  noInhouseTa?: boolean;
  staleOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface CompanyPatch {
  name?: string;
  domain?: string | null;
  headcount?: number | null;
  industry?: string | null;
  website?: string | null;
  careersUrl?: string | null;
  linkedinUrl?: string | null;
  hqLocation?: string | null;
  fundingStage?: string | null;
  recruiterCount?: number | null;
  hasInhouseTa?: boolean | null;
  notes?: string | null;
  status?: string;
  reviewed?: boolean;
}

export interface ContactPatch {
  fullName?: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  persona?: Persona | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  isPrimary?: boolean;
  status?: string;
  reviewed?: boolean;
  notes?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export type SourceKey =
  | 'yc'
  | 'ats_sweep'
  | 'careers_crawl'
  | 'hn_whoishiring'
  | 'sec_formd'
  | 'linkedin'
  | 'contact_discovery'
  | 'email_verify'
  | 'scoring'
  | 'draft_generation';

export interface SourceStatus {
  key: SourceKey;
  label: string;
  description: string;
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
  recordsFound: number;
  progress: { done: number; total: number } | null;
  /** Non-null means running it will spend money. */
  estimatedCostUsd: number | null;
  requiresKey: string | null;
}

export interface PipelineState {
  sources: SourceStatus[];
  running: boolean;
  log: LogLine[];
  spend: { provider: string; spentUsd: number; capUsd: number }[];
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outreach
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftRow {
  id: string;
  companyId: string;
  companyName: string;
  contactId: string;
  contactName: string;
  contactTitle: string | null;
  toEmail: string | null;
  emailVerdict: VerificationVerdict;
  subject: string;
  body: string;
  reqIds: number[];
  state: string;
  edited: boolean;
  scheduledAt: number | null;
  qualityScore: number | null;
}

export interface SendStats {
  today: number;
  thisHour: number;
  dailyLimit: number;
  hourlyLimit: number;
  queued: number;
  nextSendAt: number | null;
  running: boolean;
  windowStart: string;
  windowEnd: string;
  inWindow: boolean;
}

export interface InboundRow {
  id: string;
  kind: 'reply' | 'bounce' | 'auto_reply' | 'unmatched';
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: number;
  handled: boolean;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  sendId: string | null;
  bounceRecipient: string | null;
  bounceStatus: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export interface Settings {
  icp: {
    minHeadcount: number;
    maxHeadcount: number;
    maxInhouseRecruiters: number;
    staleDays: number;
    excludedKeywords: string[];
    requireBayArea: boolean;
  };
  sending: {
    perHour: number;
    perDay: number;
    windowStart: string;
    windowEnd: string;
    jitterPct: number;
    weekends: boolean;
    signature: string;
    includeOptOutLine: boolean;
  };
  crawl: {
    concurrency: number;
    linkedinPerDay: number;
    linkedinEnabled: boolean;
  };
  gmail: {
    connected: boolean;
    address: string | null;
    needsReauth: boolean;
  };
  keys: {
    verifierProvider: 'reoon' | 'bouncer' | 'millionverifier' | 'none';
    verifierKeySet: boolean;
    anthropicKeySet: boolean;
  };
  spendCapUsd: number;
  dataDir: string;
}

export interface SettingsPatch {
  icp?: Partial<Settings['icp']>;
  sending?: Partial<Settings['sending']>;
  crawl?: Partial<Settings['crawl']>;
  spendCapUsd?: number;
}

export interface SuppressionRow {
  id: number;
  kind: 'domain' | 'email' | 'company';
  value: string;
  reason: string;
  note: string | null;
  createdAt: number;
}

export interface DashboardStats {
  companies: number;
  reviewed: number;
  approved: number;
  contacts: number;
  verifiedContacts: number;
  openReqs: number;
  drafts: number;
  sent: number;
  replies: number;
  bounces: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The full API surface. Keep alphabetical within groups.
// ─────────────────────────────────────────────────────────────────────────────

export interface RecruitApi {
  // companies
  listCompanies(params: CompanyListParams): Promise<CompanyRow[]>;
  getCompany(id: string): Promise<CompanyDetail | null>;
  patchCompany(id: string, patch: CompanyPatch): Promise<CompanyDetail>;
  bulkCompanyStatus(ids: string[], status: string): Promise<number>;
  resolveConflict(entityId: string, field: string, observationId: number): Promise<void>;

  // contacts
  patchContact(id: string, patch: ContactPatch): Promise<ContactRow>;
  addContact(companyId: string, patch: ContactPatch): Promise<ContactRow>;
  deleteContact(id: string): Promise<void>;
  findContacts(companyId: string): Promise<ContactRow[]>;
  verifyContact(id: string): Promise<ContactRow>;

  // pipeline
  getPipeline(): Promise<PipelineState>;
  runSource(key: SourceKey): Promise<void>;
  runAll(): Promise<void>;
  stopPipeline(): Promise<void>;
  setSourceEnabled(key: SourceKey, enabled: boolean): Promise<void>;

  // outreach
  listDrafts(state?: string): Promise<DraftRow[]>;
  generateDraft(companyId: string, contactId?: string): Promise<DraftRow>;
  patchDraft(id: string, patch: { subject?: string; body?: string }): Promise<DraftRow>;
  queueDraft(id: string): Promise<void>;
  skipDraft(id: string): Promise<void>;
  sendNow(id: string): Promise<void>;
  getSendStats(): Promise<SendStats>;
  startSending(): Promise<void>;
  pauseSending(): Promise<void>;
  listInbound(handled?: boolean): Promise<InboundRow[]>;
  markInbound(id: string, action: 'positive' | 'negative' | 'bounce' | 'ignore'): Promise<void>;
  syncInbox(): Promise<number>;

  // settings
  getSettings(): Promise<Settings>;
  patchSettings(patch: SettingsPatch): Promise<Settings>;
  setSecret(key: string, value: string): Promise<void>;
  testKey(which: 'verifier' | 'anthropic'): Promise<{ ok: boolean; message: string }>;
  connectGmail(): Promise<{ ok: boolean; address?: string; message: string }>;
  disconnectGmail(): Promise<void>;
  testGmail(): Promise<{ ok: boolean; message: string }>;

  // suppression
  listSuppressions(): Promise<SuppressionRow[]>;
  addSuppression(kind: string, value: string, reason: string, note?: string): Promise<void>;
  removeSuppression(id: number): Promise<void>;
  importSuppressionsCsv(csv: string): Promise<number>;

  // misc
  getStats(): Promise<DashboardStats>;
  exportCsv(what: 'companies' | 'contacts' | 'drafts'): Promise<string>;
  backupNow(): Promise<string>;
  openDataDir(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getScreenshot(relPath: string): Promise<string | null>;
}

/** Events pushed main → renderer. */
export interface RecruitEvents {
  'pipeline:progress': PipelineState;
  'pipeline:log': LogLine;
  'send:progress': SendStats;
  'data:changed': { entity: 'company' | 'contact' | 'draft' | 'inbound'; id?: string };
  'gmail:needs-reauth': { address: string | null };
}

export type EventName = keyof RecruitEvents;
