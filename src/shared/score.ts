/**
 * Company quality scoring.
 *
 * The business model is contingency at 30% of first-year salary, so the ranking
 * is fundamentally: expected fee x probability they'll engage an agency x
 * probability we can fill it. Everything below is a proxy for one of those three.
 *
 * Scores are computed to 0-100 internally, then mapped to the 1-10 the operator
 * sees. Every component returns a human-readable reason, because a score you
 * can't explain is a score you can't trust or tune.
 */

import type { Company, Contact, Requisition } from './types.js';

export const FEE_RATE = 0.3;

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  max: number;
  reason: string;
}

export interface ScoreResult {
  /** 1-10, what the operator sees. */
  score: number;
  /** 0-100 internal. */
  raw: number;
  components: ScoreComponent[];
  /** Non-null means excluded from outreach entirely. */
  disqualified: string | null;
  /** One-line summary rendered in the "Why this company" panel. */
  headline: string;
  estimatedFeeUsd: number | null;
}

export interface ScoreInput {
  company: Company;
  reqs: Requisition[];
  contacts: Contact[];
  now?: Date;
}

export interface IcpConfig {
  minHeadcount: number;
  maxHeadcount: number;
  /** A company with more in-house recruiters than this is deprioritised, not rejected. */
  maxInhouseRecruiters: number;
  /** Reqs open longer than this are "stale" — the strongest pitch hook. */
  staleDays: number;
  excludedKeywords: string[];
  requireBayArea: boolean;
}

export const DEFAULT_ICP: IcpConfig = {
  minHeadcount: 3,
  maxHeadcount: 1000,
  maxInhouseRecruiters: 2,
  staleDays: 45,
  excludedKeywords: [],
  requireBayArea: true,
};

// ─────────────────────────────────────────────────────────────────────────────

export function scoreCompany(input: ScoreInput, icp: IcpConfig = DEFAULT_ICP): ScoreResult {
  const { company, reqs, contacts } = input;
  const now = input.now ?? new Date();

  const dq = disqualify(company, reqs, icp);
  if (dq) {
    return { score: 0, raw: 0, components: [], disqualified: dq, headline: dq, estimatedFeeUsd: null };
  }

  const openReqs = reqs.filter((r) => !r.closedAt);
  const components: ScoreComponent[] = [
    scoreHiringVolume(openReqs, icp, now),
    scoreFeePotential(openReqs),
    scoreAgencyFit(company, icp),
    scoreCompanyQuality(company),
    scoreContactability(contacts),
  ];

  const raw = clamp(
    components.reduce((sum, c) => sum + c.points, 0),
    0,
    100,
  );

  return {
    score: rawToTen(raw),
    raw: Math.round(raw),
    components,
    disqualified: null,
    headline: buildHeadline(company, openReqs, icp, now),
    estimatedFeeUsd: estimateTotalFee(openReqs),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard disqualifiers — these remove a company from outreach entirely
// ─────────────────────────────────────────────────────────────────────────────

function disqualify(company: Company, reqs: Requisition[], icp: IcpConfig): string | null {
  if (company.status === 'suppressed') return 'Suppressed';

  // An explicit "no agencies" disclaimer in a JD is the company telling us not to
  // contact them. Emailing anyway is a guaranteed zero with negative brand value.
  if (company.noAgencyPolicy || reqs.some((r) => r.noAgencyDisclaimer)) {
    return 'Job posting states no agency submissions';
  }

  if (icp.requireBayArea && !company.inBayArea) return 'Outside Bay Area';

  const hc = company.headcount;
  if (hc != null && hc < icp.minHeadcount) return `Too small (${hc} people)`;
  if (hc != null && hc > icp.maxHeadcount) return `Too large (${hc} people)`;

  if (reqs.filter((r) => !r.closedAt).length === 0) return 'No open roles';

  if (icp.excludedKeywords.length) {
    const haystack = `${company.name} ${company.industry ?? ''}`.toLowerCase();
    const hit = icp.excludedKeywords.find((k) => k && haystack.includes(k.toLowerCase()));
    if (hit) return `Excluded keyword: ${hit}`;
  }

  // Competing agencies are the most obvious own-goal in the list.
  if (looksLikeRecruitingAgency(company.name, company.industry)) {
    return 'Appears to be a staffing/recruiting firm';
  }

  return null;
}

const AGENCY_MARKERS = [
  'recruit', 'staffing', 'talent partners', 'headhunt', 'executive search',
  'talent solutions', 'rpo', 'placement', 'personnel',
];

export function looksLikeRecruitingAgency(name: string, industry: string | null): boolean {
  const h = `${name} ${industry ?? ''}`.toLowerCase();
  return AGENCY_MARKERS.some((m) => h.includes(m));
}

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

/** Hiring volume and urgency — 30 pts. A stale req is the single best pitch hook. */
function scoreHiringVolume(reqs: Requisition[], icp: IcpConfig, now: Date): ScoreComponent {
  const n = reqs.length;
  const stale = reqs.filter((r) => daysOpen(r, now) >= icp.staleDays);
  const veryStale = reqs.filter((r) => daysOpen(r, now) >= icp.staleDays * 2);
  const reposted = reqs.filter((r) => r.repostCount > 0);

  // Volume: diminishing returns. 1 req is a real signal; 40 reqs isn't 40x better.
  const volumePts = Math.min(14, Math.log2(n + 1) * 4);
  const stalePts = Math.min(10, stale.length * 3);
  const veryStalePts = Math.min(4, veryStale.length * 2);
  const repostPts = Math.min(2, reposted.length);

  const points = volumePts + stalePts + veryStalePts + repostPts;

  const bits = [`${n} open role${n === 1 ? '' : 's'}`];
  if (stale.length) bits.push(`${stale.length} open >${icp.staleDays}d`);
  if (reposted.length) bits.push(`${reposted.length} reposted`);

  return { key: 'hiring', label: 'Hiring volume & urgency', points, max: 30, reason: bits.join(' · ') };
}

/** Fee potential — 25 pts. Direct expected revenue at the 30% contingency rate. */
function scoreFeePotential(reqs: Requisition[]): ScoreComponent {
  const fee = estimateTotalFee(reqs);
  if (fee == null) {
    // No comp data isn't evidence of a low fee — give a neutral score rather than
    // punishing companies whose ATS doesn't publish ranges.
    return {
      key: 'fee',
      label: 'Fee potential',
      points: 10,
      max: 25,
      reason: 'No published comp — assumed median',
    };
  }
  // $50k total fee saturates. Below ~$15k the engagement may not clear cost-to-serve.
  const points = clamp((fee / 50_000) * 25, 0, 25);
  return {
    key: 'fee',
    label: 'Fee potential',
    points,
    max: 25,
    reason: `~${usd(fee)} across open roles at ${Math.round(FEE_RATE * 100)}%`,
  };
}

/**
 * Agency fit — 25 pts. The highest-signal component in the whole model.
 *
 * A company with 14 reqs and no in-house recruiter is a near-perfect buyer.
 * A company with 14 reqs and six recruiters is hostile: the Head of Talent's
 * position is threatened by the pitch. These look identical in every
 * firmographic filter, which is exactly why this is worth computing.
 */
function scoreAgencyFit(company: Company, icp: IcpConfig): ScoreComponent {
  let points = 0;
  const bits: string[] = [];

  const recruiters = company.recruiterCount;
  if (recruiters === 0 || company.hasInhouseTa === false) {
    points += 15;
    bits.push('no in-house recruiter');
  } else if (recruiters == null) {
    points += 7;
    bits.push('in-house TA unknown');
  } else if (recruiters <= icp.maxInhouseRecruiters) {
    points += 8;
    bits.push(`${recruiters} in-house recruiter${recruiters === 1 ? '' : 's'}`);
  } else {
    points += 1;
    bits.push(`${recruiters} in-house recruiters — likely handles own hiring`);
  }

  // Size band. 20-75 with no TA is the sweet spot: the founder or VP Eng decides,
  // fast, and there's no internal team whose budget you're competing with.
  const hc = company.headcount;
  if (hc != null) {
    if (hc >= 20 && hc <= 75) {
      points += 10;
      bits.push('ideal size band');
    } else if (hc > 75 && hc <= 300) {
      points += 7;
    } else if (hc >= 10 && hc < 20) {
      points += 6;
    } else if (hc < 10) {
      points += 3;
      bits.push('very early — may not pay a 30% fee');
    } else {
      points += 2;
      bits.push('large — may have procurement/PSL');
    }
  } else {
    points += 4;
  }

  return { key: 'fit', label: 'Agency fit', points, max: 25, reason: bits.join(' · ') };
}

/** Company quality — 10 pts. Recent funding is the classic trigger event. */
function scoreCompanyQuality(company: Company): ScoreComponent {
  let points = 0;
  const bits: string[] = [];

  if (company.lastRoundAt) {
    const months = monthsSince(company.lastRoundAt);
    if (months <= 6) {
      points += 6;
      bits.push(`funded ${Math.max(1, Math.round(months))}mo ago`);
    } else if (months <= 12) {
      points += 4;
      bits.push('funded within a year');
    } else if (months <= 24) {
      points += 2;
    }
  }

  if (company.ycBatch) {
    points += 2;
    bits.push(`YC ${company.ycBatch}`);
  }
  if (company.fundingStage) bits.push(company.fundingStage);
  if (company.atsPlatform) points += 2; // a real ATS implies real hiring process

  return {
    key: 'quality',
    label: 'Company quality',
    points: Math.min(points, 10),
    max: 10,
    reason: bits.join(' · ') || 'No funding signal',
  };
}

/** Contactability — 10 pts. A perfect prospect we can't reach is worth nothing. */
function scoreContactability(contacts: Contact[]): ScoreComponent {
  if (contacts.length === 0) {
    return { key: 'contact', label: 'Contactability', points: 0, max: 10, reason: 'No contacts found' };
  }

  const valid = contacts.filter((c) => c.emailVerdict === 'valid');
  const catchAll = contacts.filter((c) => c.emailVerdict === 'catch_all');
  const decisionMakers = contacts.filter(
    (c) => c.persona === 'founder_ceo' || c.persona === 'cto_vpe' || c.persona === 'head_of_talent',
  );

  let points = 0;
  const bits: string[] = [];

  if (valid.length > 0) {
    points += 6;
    bits.push(`${valid.length} verified email${valid.length === 1 ? '' : 's'}`);
  } else if (catchAll.length > 0) {
    points += 2;
    bits.push('catch-all only');
  }

  if (decisionMakers.length > 0) {
    points += 4;
    bits.push(`${decisionMakers.length} decision maker${decisionMakers.length === 1 ? '' : 's'}`);
  }

  return { key: 'contact', label: 'Contactability', points: Math.min(points, 10), max: 10, reason: bits.join(' · ') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact-level scoring — decides who to email FIRST at a company
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persona weights vary by company size, and one case inverts.
 *
 * At 20-75 people with a first in-house Head of Talent, that person is
 * frequently a blocker rather than a buyer — agency spend competes with their
 * headcount budget and implicitly says they're failing. Below 20 the founder
 * decides directly. Above 75 the Head of Talent genuinely owns the vendor list.
 */
export function scoreContact(contact: Contact, company: Company): number {
  const hc = company.headcount ?? 30;
  let base: number;

  switch (contact.persona) {
    case 'founder_ceo':
      base = hc <= 75 ? 100 : hc <= 300 ? 60 : 30;
      break;
    case 'cto_vpe':
      base = hc <= 20 ? 80 : hc <= 300 ? 90 : 70;
      break;
    case 'head_of_talent':
      if (hc < 20) base = 50;
      else if (hc <= 75) base = company.hasInhouseTa ? 40 : 65; // possible blocker
      else base = 95;
      break;
    case 'recruiter':
      base = hc > 75 ? 70 : 45;
      break;
    case 'hiring_manager':
      base = 60;
      break;
    case 'coo_ops':
      base = hc <= 75 ? 70 : 45;
      break;
    default:
      base = 25;
  }

  // Reachability multiplier. An unreachable perfect persona ranks below a
  // reachable good one.
  const verdictMultiplier =
    contact.emailVerdict === 'valid' ? 1
    : contact.emailVerdict === 'catch_all' ? 0.55
    : contact.emailVerdict === 'unknown' ? 0.35
    : contact.emailVerdict === 'unverified' ? 0.25
    : 0.05;

  return Math.round(base * verdictMultiplier);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function daysOpen(req: Requisition, now = new Date()): number {
  const start = req.publishedAt ?? req.firstSeenAt;
  if (!start) return 0;
  const end = req.closedAt ? new Date(req.closedAt) : now;
  const ms = end.getTime() - new Date(start).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function estimateReqFee(req: Requisition): number | null {
  if (req.compMin == null && req.compMax == null) return null;
  const mid =
    req.compMin != null && req.compMax != null
      ? (req.compMin + req.compMax) / 2
      : (req.compMin ?? req.compMax)!;
  if (mid < 20_000 || mid > 2_000_000) return null;
  return Math.round(mid * FEE_RATE);
}

export function estimateTotalFee(reqs: Requisition[]): number | null {
  const fees = reqs.map(estimateReqFee).filter((f): f is number => f != null);
  if (fees.length === 0) return null;
  // Assume we'd realistically place a fraction of open roles, not all of them.
  // Top 3 by value is a defensible planning figure.
  const top = fees.sort((a, b) => b - a).slice(0, 3);
  return top.reduce((s, f) => s + f, 0);
}

function buildHeadline(company: Company, reqs: Requisition[], icp: IcpConfig, now: Date): string {
  const bits: string[] = [];
  const eng = reqs.filter((r) => isEngineering(r));
  bits.push(`${reqs.length} open role${reqs.length === 1 ? '' : 's'}${eng.length ? ` (${eng.length} eng)` : ''}`);

  const stale = reqs.filter((r) => daysOpen(r, now) >= icp.staleDays);
  if (stale.length) {
    const oldest = Math.max(...stale.map((r) => daysOpen(r, now)));
    bits.push(`${stale.length} open >${icp.staleDays}d (oldest ${oldest}d)`);
  }
  if (company.recruiterCount === 0 || company.hasInhouseTa === false) bits.push('no in-house recruiter');
  if (company.lastRoundAt) {
    const m = Math.round(monthsSince(company.lastRoundAt));
    if (m <= 12) bits.push(`${company.fundingStage ?? 'funded'} ${m}mo ago`);
  }
  const fee = estimateTotalFee(reqs);
  if (fee) bits.push(`~${usd(fee)} potential fee`);

  return bits.join(' · ');
}

const ENG_MARKERS = /engineer|developer|swe|infrastructure|backend|frontend|full.?stack|platform|ml |machine learning|data scien|research|devops|sre|security|mobile|ios|android/i;

export function isEngineering(req: Requisition): boolean {
  return ENG_MARKERS.test(`${req.title} ${req.department ?? ''}`);
}

function monthsSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (30.44 * 86_400_000);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map 0-100 to 1-10.
 *
 * Deliberately not a linear tenth. Raw scores cluster in the 30-70 band, and a
 * linear map would put almost everything at 4-7 and waste the scale. These
 * breakpoints spread the middle and reserve 9-10 for genuinely exceptional
 * records so the top of the list stays meaningful.
 */
function rawToTen(raw: number): number {
  const breaks = [12, 22, 31, 39, 47, 55, 63, 72, 82];
  let score = 1;
  for (const b of breaks) if (raw >= b) score++;
  return Math.min(10, score);
}

function usd(n: number): string {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}
