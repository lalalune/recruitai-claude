/**
 * Recompute every derived company field, then run the shared scoring engine.
 *
 * The derived fields (open_req_count, stale_req_count, max_days_open,
 * estimated_fee_usd, no_agency_policy) are never hand-edited — they are a pure
 * function of the req rows, so this job can be re-run at any time and converge.
 *
 * Classification here is deliberately deterministic. "Does this JD refuse agency
 * submissions" is a phrase-matching problem with a small, stable vocabulary; an
 * LLM would be slower, cost money, and be less reproducible for a field that
 * disqualifies a company from outreach entirely.
 */

import { all, get, run, tx, type Db } from '../db/index.js';
import { COMPANY_SUPPRESSION_MATCH } from './suppression.js';
import { getIcp } from '../settings.js';
import {
  scoreCompany,
  scoreContact,
  estimateTotalFee,
  isEngineering,
  daysOpen,
  type IcpConfig,
} from '../../shared/score.js';
import type { Company, Contact, Requisition } from '../../shared/types.js';
import type { RunCtx, SourceOutcome } from './run.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic JD classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An explicit refusal in the posting. Emailing anyway is a guaranteed zero with
 * negative brand value, so this is treated as a hard disqualifier upstream.
 */
const NO_AGENCY_PATTERNS: RegExp[] = [
  /unsolicited\s+(?:resum|cv|candidate|profile|referral|applicant)/i,
  /\bno\s+agenc(?:y|ies)\b/i,
  /(?:do|does)\s+not\s+accept\s+(?:unsolicited\s+)?(?:resumes?|cvs?|candidates?|submissions?)\s+from\s+(?:any\s+)?(?:staffing|recruit|agenc|third[- ]part)/i,
  /(?:do|does)\s+not\s+accept\s+agency/i,
  /without\s+a\s+(?:signed|valid|written|prior)\s+(?:written\s+)?agreement/i,
  /agency\s+submissions?\s+(?:are\s+)?(?:not\s+accepted|will\s+not)/i,
  /not\s+(?:currently\s+)?(?:accepting|working\s+with)\s+(?:external\s+)?(?:recruit|agenc|third[- ]part)/i,
  /third[- ]party\s+recruit(?:ers?|ing)\s+(?:agenc\w+\s+)?(?:are\s+)?not/i,
  /\bno\s+recruiters?\s+please\b/i,
  /will\s+not\s+pay\s+(?:any\s+)?(?:fee|placement)/i,
];

export function classifyNoAgency(text: string | null | undefined): boolean {
  if (!text) return false;
  // Cap the scan: the disclaimer is boilerplate that lives near the end of the
  // template, and full-length regex passes over 400k JDs are measurably slow.
  const haystack = text.length > 20_000 ? `${text.slice(0, 4_000)}\n${text.slice(-8_000)}` : text;
  return NO_AGENCY_PATTERNS.some((re) => re.test(haystack));
}

const FUNCTION_FAMILIES: { family: string; re: RegExp }[] = [
  { family: 'engineering', re: /engineer|developer|\bswe\b|programmer|architect|infrastructure|backend|front.?end|full.?stack|platform|devops|\bsre\b|site reliability|mobile|\bios\b|android|firmware|embedded|compiler|systems/i },
  { family: 'data_ml', re: /machine learning|\bml\b|\bai\b research|data scien|data engineer|analytics engineer|research (?:scientist|engineer)|applied scien|\bnlp\b|computer vision|quantitative/i },
  { family: 'security', re: /security|appsec|infosec|\bgrc\b|compliance engineer|penetration|threat/i },
  { family: 'product', re: /product manager|\bpm\b|product owner|technical program|\btpm\b|program manager/i },
  { family: 'design', re: /designer|design lead|\bux\b|\bui\b designer|user research|brand studio/i },
  { family: 'sales', re: /account executive|sales|business development|\bbdr\b|\bsdr\b|revenue|partnerships/i },
  { family: 'marketing', re: /marketing|growth|demand gen|content strateg|communications|\bseo\b|brand manager/i },
  { family: 'customer', re: /customer success|support engineer|solutions (?:engineer|architect)|technical account|implementation/i },
  { family: 'operations', re: /operations|\bops\b|supply chain|logistics|business operations|strategy/i },
  { family: 'finance', re: /finance|accounting|controller|\bfp&a\b|treasury|payroll/i },
  { family: 'people', re: /recruiter|talent|people ops|human resources|\bhr\b|sourcer/i },
  { family: 'legal', re: /legal|counsel|attorney|paralegal/i },
];

export function classifyFunctionFamily(title: string, department: string | null): string | null {
  const haystack = `${title} ${department ?? ''}`;
  for (const { family, re } of FUNCTION_FAMILIES) {
    if (re.test(haystack)) return family;
  }
  return null;
}

const SENIORITY_LEVELS: { level: string; re: RegExp }[] = [
  { level: 'executive', re: /\b(chief|c[teofm]o\b|cto|ceo|cfo|coo|cpo|cro|president|founder|head of|\bvp\b|vice president|svp|evp)\b/i },
  { level: 'director', re: /\b(director|principal|distinguished|fellow)\b/i },
  { level: 'manager', re: /\b(manager|lead|leader|supervisor)\b/i },
  { level: 'staff', re: /\b(staff|senior staff)\b/i },
  { level: 'senior', re: /\b(senior|sr\.?|iii|iv)\b/i },
  { level: 'junior', re: /\b(junior|jr\.?|associate|entry|new grad|graduate|intern|apprentice|\bi\b)\b/i },
];

export function classifySeniority(title: string): string | null {
  for (const { level, re } of SENIORITY_LEVELS) {
    if (re.test(title)) return level;
  }
  return 'mid';
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → domain object
// ─────────────────────────────────────────────────────────────────────────────

interface CompanyRowRaw {
  id: string;
  domain: string | null;
  name: string;
  name_norm: string;
  headcount: number | null;
  industry: string | null;
  hq_location: string | null;
  in_bay_area: number;
  funding_stage: string | null;
  last_round_at: number | null;
  yc_batch: string | null;
  ats_platform: string | null;
  ats_token: string | null;
  careers_url: string | null;
  linkedin_url: string | null;
  recruiter_count: number | null;
  has_inhouse_ta: number | null;
  no_agency_policy: number;
  status: Company['status'];
  reviewed: number;
  reviewed_at: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface ReqRowRaw {
  id: number;
  company_id: string;
  external_id: string;
  source: string;
  title: string;
  department: string | null;
  team: string | null;
  location: string | null;
  is_remote: number | null;
  employment_type: string | null;
  comp_min: number | null;
  comp_max: number | null;
  description: string | null;
  url: string;
  first_seen_at: number;
  last_seen_at: number;
  published_at: number | null;
  closed_at: number | null;
  days_open: number | null;
  repost_count: number;
  function_family: string | null;
  seniority: string | null;
  no_agency_disclaimer: number | null;
  named_contact: string | null;
}

interface ContactRowRaw {
  id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  title: string | null;
  persona: string | null;
  seniority: string | null;
  email: string | null;
  email_source: string | null;
  email_verdict: Contact['emailVerdict'];
  email_verified_at: number | null;
  phone: string | null;
  linkedin_url: string | null;
  is_primary: number;
  contact_score: number | null;
  status: Contact['status'];
  reviewed: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());

export function toCompanyDomain(row: CompanyRowRaw, derived: DerivedCounts): Company {
  return {
    id: row.id,
    domain: row.domain,
    name: row.name,
    nameNorm: row.name_norm,
    headcount: row.headcount,
    headcountSource: null,
    industry: row.industry,
    hqLocation: row.hq_location,
    inBayArea: row.in_bay_area === 1,
    fundingStage: row.funding_stage,
    lastRoundAt: iso(row.last_round_at),
    atsPlatform: (row.ats_platform as Company['atsPlatform']) ?? null,
    atsToken: row.ats_token,
    careersUrl: row.careers_url,
    linkedinUrl: row.linkedin_url,
    ycBatch: row.yc_batch,
    openReqCount: derived.openReqCount,
    openReqEngCount: derived.openReqEngCount,
    maxDaysOpen: derived.maxDaysOpen,
    staleReqCount: derived.staleReqCount,
    recruiterCount: row.recruiter_count,
    hasInhouseTa: row.has_inhouse_ta == null ? null : row.has_inhouse_ta === 1,
    noAgencyPolicy: derived.noAgencyPolicy,
    qualityScore: null,
    scoreBreakdown: null,
    status: row.status,
    reviewed: row.reviewed === 1,
    reviewedAt: iso(row.reviewed_at),
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function toReqDomain(row: ReqRowRaw): Requisition {
  return {
    id: String(row.id),
    companyId: row.company_id,
    externalId: row.external_id,
    source: row.source as Requisition['source'],
    title: row.title,
    department: row.department,
    team: row.team,
    location: row.location,
    isRemote: row.is_remote == null ? null : row.is_remote === 1,
    employmentType: row.employment_type,
    compMin: row.comp_min,
    compMax: row.comp_max,
    descriptionText: row.description,
    url: row.url,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    publishedAt: iso(row.published_at),
    closedAt: iso(row.closed_at),
    daysOpen: row.days_open,
    repostCount: row.repost_count,
    functionFamily: row.function_family,
    seniority: row.seniority,
    noAgencyDisclaimer: row.no_agency_disclaimer == null ? null : row.no_agency_disclaimer === 1,
    namedContact: row.named_contact,
  };
}

export function toContactDomain(row: ContactRowRaw): Contact {
  return {
    id: row.id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    title: row.title,
    persona: (row.persona as Contact['persona']) ?? null,
    seniority: row.seniority,
    email: row.email,
    emailSource: (row.email_source as Contact['emailSource']) ?? null,
    emailVerdict: row.email_verdict,
    emailVerifiedAt: iso(row.email_verified_at),
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    isPrimary: row.is_primary === 1,
    contactScore: row.contact_score,
    status: row.status,
    reviewed: row.reviewed === 1,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived fields
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedCounts {
  openReqCount: number;
  openReqEngCount: number;
  staleReqCount: number;
  maxDaysOpen: number | null;
  noAgencyPolicy: boolean;
  estimatedFeeUsd: number | null;
}

export function deriveCounts(reqs: Requisition[], icp: IcpConfig, now: Date): DerivedCounts {
  const open = reqs.filter((r) => !r.closedAt);
  const ages = open.map((r) => daysOpen(r, now));
  return {
    openReqCount: open.length,
    openReqEngCount: open.filter(isEngineering).length,
    staleReqCount: ages.filter((d) => d >= icp.staleDays).length,
    maxDaysOpen: ages.length ? Math.max(...ages) : null,
    noAgencyPolicy: reqs.some((r) => r.noAgencyDisclaimer === true),
    estimatedFeeUsd: estimateTotalFee(open),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute one company end to end. Idempotent: safe to call after any write
 * that could have changed reqs, contacts, or the ICP configuration.
 */
export function recomputeCompany(db: Db, companyId: string, icp: IcpConfig = getIcp(), now = new Date()): void {
  const row = get<CompanyRowRaw>(db, 'SELECT * FROM company WHERE id = ?', companyId);
  if (!row) return;

  // description is deliberately NULLed out: scoring never reads it (it is
  // consumed at ingest), and at a 100k-req corpus hauling JD bodies through
  // this per-company loop dominated scoreAll's measured runtime.
  const reqs = all<ReqRowRaw>(
    db,
    `SELECT id, company_id, external_id, source, title, department, team, location, is_remote,
            employment_type, comp_min, comp_max, NULL AS description, url, first_seen_at,
            last_seen_at, published_at, closed_at, days_open, repost_count, function_family,
            seniority, no_agency_disclaimer, named_contact
       FROM req WHERE company_id = ?`,
    companyId,
  ).map(toReqDomain);
  const contactRows = all<ContactRowRaw>(db, 'SELECT * FROM contact WHERE company_id = ?', companyId);
  const contacts = contactRows.map(toContactDomain);

  const derived = deriveCounts(reqs, icp, now);

  // Suppression is an identity-level decision, so it outranks everything the
  // scorer would otherwise say about the company.
  const suppressed = isSuppressed(db, row.id, row.domain);
  const status: Company['status'] = suppressed ? 'suppressed' : row.status;

  const company = toCompanyDomain({ ...row, status }, derived);
  const result = scoreCompany({ company, reqs, contacts, now }, icp);

  const nextStatus =
    suppressed ? 'suppressed'
    : row.status === 'discovered' || row.status === 'enriched' ? 'scored'
    : row.status;

  run(
    db,
    `UPDATE company SET
       open_req_count = ?, open_req_eng_count = ?, stale_req_count = ?, max_days_open = ?,
       no_agency_policy = ?, estimated_fee_usd = ?,
       quality_score = ?, score_raw = ?, score_breakdown = ?, score_headline = ?, disqualified = ?,
       status = ?, updated_at = ?
     WHERE id = ?`,
    derived.openReqCount,
    derived.openReqEngCount,
    derived.staleReqCount,
    derived.maxDaysOpen,
    derived.noAgencyPolicy ? 1 : 0,
    derived.estimatedFeeUsd,
    result.disqualified ? null : result.score,
    result.disqualified ? null : result.raw,
    JSON.stringify(result.components),
    result.headline,
    result.disqualified,
    nextStatus,
    Date.now(),
    companyId,
  );

  for (const contact of contacts) {
    const score = scoreContact(contact, company);
    run(db, 'UPDATE contact SET contact_score = ?, updated_at = ? WHERE id = ?', score, Date.now(), contact.id);
  }

  electPrimaryContact(db, companyId);
}

/**
 * Exactly one contact per company carries the star. The highest-scoring
 * reachable contact wins unless the operator has already made the call — a
 * human-set primary is never silently reassigned.
 */
export function electPrimaryContact(db: Db, companyId: string): void {
  const manual = get<{ id: string }>(
    db,
    'SELECT id FROM contact WHERE company_id = ? AND is_primary = 1 AND reviewed = 1 LIMIT 1',
    companyId,
  );
  if (manual) {
    run(db, 'UPDATE contact SET is_primary = 0 WHERE company_id = ? AND id != ?', companyId, manual.id);
    return;
  }

  const best = get<{ id: string }>(
    db,
    `SELECT id FROM contact
      WHERE company_id = ? AND status != 'rejected'
      ORDER BY (email IS NULL), contact_score DESC, created_at
      LIMIT 1`,
    companyId,
  );
  run(db, 'UPDATE contact SET is_primary = 0 WHERE company_id = ?', companyId);
  if (best) run(db, 'UPDATE contact SET is_primary = 1 WHERE id = ?', best.id);
}

export function isSuppressed(db: Db, companyId: string, domain: string | null): boolean {
  // The same triple-identity company match every other barrier uses — the old
  // inline version compared the raw uppercase ULID against lowercased stored
  // values (never matched) and had no name arm at all, so a name-kind
  // suppression was invisible to scoring. Suppression-side seeks stay bare;
  // lower() is applied to the company/parameter side only.
  const row = get<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression s
      WHERE (s.kind = 'company' AND EXISTS (SELECT 1 FROM company co WHERE co.id = ? AND ${COMPANY_SUPPRESSION_MATCH}))
         OR (s.kind = 'domain' AND ? IS NOT NULL AND s.value = lower(?))`,
    companyId,
    domain,
    domain,
  );
  return (row?.n ?? 0) > 0;
}

/** Re-score every non-merged company. */
export async function scoreAll(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const icp = getIcp();
  const now = new Date();
  const ids = all<{ id: string }>(db, 'SELECT id FROM company WHERE canonical_id IS NULL ORDER BY created_at').map(
    (r) => r.id,
  );

  ctx.log('info', `Scoring ${ids.length} companies against the current ICP…`);
  ctx.progress(0, ids.length);

  let done = 0;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (ctx.cancelled()) break;
    const chunk = ids.slice(i, i + CHUNK);
    tx(db, () => {
      for (const id of chunk) recomputeCompany(db, id, icp, now);
    });
    done += chunk.length;
    ctx.progress(done, ids.length);
    // Yield to the event loop between chunks: this loop had zero awaits, so a
    // 10k-company rescore blocked every IPC handler for the full ~1.3 s.
    await new Promise<void>((r) => setImmediate(r));
  }

  const qualified = get<{ n: number }>(
    db,
    // canonical_id IS NULL: merged-away duplicates keep their last score and
    // would otherwise inflate this tally.
    'SELECT count(*) AS n FROM company WHERE canonical_id IS NULL AND disqualified IS NULL AND quality_score >= 6',
  );
  return {
    records: done,
    message: `${done} companies scored, ${qualified?.n ?? 0} at quality 6+`,
  };
}
