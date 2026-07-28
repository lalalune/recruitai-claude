/**
 * Core domain types.
 *
 * Design rule that governs this whole file: contact values (email, phone) are
 * never produced by a model. They are only ever observed from a source or typed
 * by the operator. `FieldObservation` is how that is enforced downstream — every
 * value carries the evidence it came from.
 */

export type SourceId =
  | 'yc'
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'smartrecruiters'
  | 'workable'
  | 'workday'
  | 'careers_page'
  | 'hn_whoishiring'
  | 'sec_formd'
  | 'linkedin'
  | 'dns'
  | 'verifier'
  | 'pattern_inference'
  | 'human';

export type AtsPlatform =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'smartrecruiters'
  | 'workable'
  | 'workday';

/** Confidence that a *specific observed value* is correct, not model confidence. */
export type Confidence = 'high' | 'medium' | 'low';

export interface FieldObservation {
  id: string;
  entityType: 'company' | 'contact' | 'req';
  entityId: string;
  field: string;
  value: string | null;
  source: SourceId;
  /** FK to raw_documents. NOT NULL in the DB — no value without evidence. */
  evidenceId: string | null;
  confidence: Confidence;
  observedAt: string;
}

export interface Company {
  id: string;
  /** eTLD+1. Primary natural key. */
  domain: string | null;
  name: string;
  nameNorm: string;
  headcount: number | null;
  headcountSource: SourceId | null;
  industry: string | null;
  hqLocation: string | null;
  inBayArea: boolean;
  fundingStage: string | null;
  lastRoundAt: string | null;
  atsPlatform: AtsPlatform | null;
  atsToken: string | null;
  careersUrl: string | null;
  linkedinUrl: string | null;
  ycBatch: string | null;

  /** Derived signals — the part that makes this database worth having. */
  openReqCount: number;
  openReqEngCount: number;
  maxDaysOpen: number | null;
  staleReqCount: number;
  recruiterCount: number | null;
  hasInhouseTa: boolean | null;
  noAgencyPolicy: boolean;

  qualityScore: number | null;
  scoreBreakdown: string | null;

  status: 'discovered' | 'enriched' | 'scored' | 'approved' | 'rejected' | 'suppressed';
  reviewed: boolean;
  reviewedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Requisition {
  id: string;
  companyId: string;
  externalId: string;
  source: SourceId;
  title: string;
  department: string | null;
  team: string | null;
  location: string | null;
  isRemote: boolean | null;
  employmentType: string | null;
  compMin: number | null;
  compMax: number | null;
  descriptionText: string | null;
  url: string;

  firstSeenAt: string;
  lastSeenAt: string;
  publishedAt: string | null;
  closedAt: string | null;
  /** Derived: days between publishedAt (or firstSeenAt) and now/closedAt. */
  daysOpen: number | null;
  repostCount: number;

  /** LLM-classified from descriptionText. Never generates contact values. */
  functionFamily: string | null;
  seniority: string | null;
  noAgencyDisclaimer: boolean | null;
  namedContact: string | null;
}

export type VerificationVerdict =
  | 'valid'
  | 'invalid'
  | 'catch_all'
  | 'unknown'
  | 'role'
  | 'disposable'
  | 'unverified';

export interface Contact {
  id: string;
  companyId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  title: string | null;
  /** Normalised buyer role, not the raw title. */
  persona: Persona | null;
  seniority: string | null;
  email: string | null;
  emailSource: SourceId | null;
  emailVerdict: VerificationVerdict;
  emailVerifiedAt: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  isPrimary: boolean;
  contactScore: number | null;
  status: 'candidate' | 'approved' | 'rejected' | 'contacted' | 'replied' | 'bounced';
  reviewed: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Who actually authorises agency spend. Varies by company size — at 20-75 people
 * with a first in-house Head of Talent, that person is frequently a blocker
 * rather than a buyer, so persona alone is not enough; it is scored against
 * headcount and hasInhouseTa.
 */
export type Persona =
  | 'founder_ceo'
  | 'cto_vpe'
  | 'head_of_talent'
  | 'recruiter'
  | 'hiring_manager'
  | 'coo_ops'
  | 'other';

export interface RawDocument {
  id: string;
  source: SourceId;
  url: string | null;
  contentHash: string;
  /** gzipped JSON or HTML. Kept forever — the operator asked for this. */
  body: Uint8Array | null;
  screenshotPath: string | null;
  fetchedAt: string;
  httpStatus: number | null;
}

export interface DiscoveredJob {
  externalId: string;
  title: string;
  department?: string | null;
  team?: string | null;
  location?: string | null;
  isRemote?: boolean | null;
  employmentType?: string | null;
  compMin?: number | null;
  compMax?: number | null;
  descriptionText?: string | null;
  url: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

export interface AtsBoard {
  platform: AtsPlatform;
  token: string;
  jobs: DiscoveredJob[];
  fetchedAt: string;
  rawBody: string;
}

export interface SourceResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
  httpStatus?: number;
  url: string;
  fetchedAt: string;
  rawBody?: string;
}
