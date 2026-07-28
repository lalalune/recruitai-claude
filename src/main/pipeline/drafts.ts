/**
 * Draft generation.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the recipient address is read from the
 * contact row at send time and is never present in, produced by, or reachable
 * from draft generation. The `draft` table has no `to_email` column by design —
 * there is nowhere for a generated address to be stored even if one existed.
 *
 * When an Anthropic key is configured, a model may rewrite the BODY PROSE. It is
 * handed a facts object that structurally cannot contain an address (see
 * `DraftFacts`), and its output is rejected outright if it contains an `@`, a
 * URL, or a phone-shaped digit run. Enforcement is in code, not in the prompt.
 */

import { all, get, run, tx, ulid, type Db } from '../db/index.js';
import { httpRequest } from '../util/http.js';
import { getSending, getSpendCapUsd, readSecret, SECRET_ANTHROPIC } from '../settings.js';
import { reserveApiCall, commitApiCall, releaseApiCall, SpendCapExceeded } from './tasks.js';
import { daysOpen, estimateReqFee, isEngineering } from '../../shared/score.js';
import { toReqDomain } from './scoring.js';
import type { RunCtx, SourceOutcome } from './run.js';

// ─────────────────────────────────────────────────────────────────────────────
// Facts — the only thing the model ever sees
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Note what is absent: no email, no phone, no URL, no contact id. The type is
 * the first of the structural barriers between a model and a contact value.
 */
export interface DraftFacts {
  companyName: string;
  contactFirstName: string;
  contactTitle: string | null;
  band: HeadcountBand;
  headcount: number | null;
  reqTitle: string;
  reqDaysOpen: number;
  reqLocation: string | null;
  reqReposted: number;
  openReqCount: number;
  openEngCount: number;
  staleReqCount: number;
  hasInhouseRecruiter: boolean | null;
  estimatedFeeUsd: number | null;
  fundingStage: string | null;
  ycBatch: string | null;
}

export type HeadcountBand = 'under_20' | '20_75' | '75_300' | 'over_300';

export function bandFor(headcount: number | null): HeadcountBand {
  if (headcount == null) return '20_75';
  if (headcount < 20) return 'under_20';
  if (headcount <= 75) return '20_75';
  if (headcount <= 300) return '75_300';
  return 'over_300';
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic templates
// ─────────────────────────────────────────────────────────────────────────────

const OPT_OUT_LINE = "If this isn't relevant, reply with 'no thanks' and I'll close the file — you won't hear from me again.";

function usd(n: number): string {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}

function recruiterClause(facts: DraftFacts): string | null {
  if (facts.hasInhouseRecruiter === false) return "you don't have an in-house recruiter carrying it";
  if (facts.hasInhouseRecruiter === true) return 'your team is carrying it alongside everything else';
  return null;
}

export function renderSubject(facts: DraftFacts): string {
  switch (facts.band) {
    case 'under_20':
      return `${facts.reqTitle} at ${facts.companyName}`;
    case '20_75':
      return facts.reqDaysOpen >= 45
        ? `Your ${facts.reqTitle} req — open ${facts.reqDaysOpen} days`
        : `${facts.reqTitle} — a few people worth meeting`;
    case '75_300':
      return facts.openEngCount > 0
        ? `${facts.openEngCount} open eng roles at ${facts.companyName}`
        : `${facts.openReqCount} open roles at ${facts.companyName}`;
    default:
      return `${facts.reqTitle} — Bay Area pipeline support`;
  }
}

/**
 * Every variable below comes from a database column. Nothing is interpolated
 * from a model, and nothing is invented — if a fact is missing, the sentence
 * that would have used it is dropped rather than softened into a guess.
 */
export function renderBody(facts: DraftFacts): string {
  const lines: string[] = [];
  const recruiter = recruiterClause(facts);
  const fee = facts.estimatedFeeUsd != null ? usd(facts.estimatedFeeUsd) : null;

  lines.push(`Hi ${facts.contactFirstName},`);
  lines.push('');

  switch (facts.band) {
    case 'under_20': {
      lines.push(
        `I saw ${facts.companyName} is hiring a ${facts.reqTitle}${facts.reqLocation ? ` in ${facts.reqLocation}` : ''}. ` +
          `At your size that search usually lands on a founder's desk on top of everything else.`,
      );
      lines.push('');
      lines.push(
        `I run a small Bay Area recruiting practice and I have people in that band I've already met. ` +
          `Happy to send two or three profiles you can judge for yourself — no retainer, and nothing owed unless you hire someone.`,
      );
      break;
    }

    case '20_75': {
      const opener =
        facts.reqDaysOpen >= 30
          ? `Your ${facts.reqTitle} posting has been up ${facts.reqDaysOpen} days`
          : `I saw you opened a ${facts.reqTitle} req`;
      lines.push(
        `${opener}${facts.reqReposted > 0 ? ` and has been reposted ${facts.reqReposted === 1 ? 'once' : `${facts.reqReposted} times`}` : ''}` +
          `${recruiter ? `, and from the outside it looks like ${recruiter}` : ''}.`,
      );
      lines.push('');
      if (facts.openReqCount > 1) {
        lines.push(
          `You've got ${facts.openReqCount} roles open${facts.openEngCount > 0 ? ` (${facts.openEngCount} on the engineering side)` : ''}` +
            `${facts.staleReqCount > 1 ? `, ${facts.staleReqCount} of them past 45 days` : ''}. That's a lot of search to run part-time.`,
        );
        lines.push('');
      }
      lines.push(
        `I place engineers and technical leads at Bay Area startups. I'd send you a shortlist for the ${facts.reqTitle} first — ` +
          `three people, each with a reason they'd move. Contingency, so there's no cost until someone signs.`,
      );
      break;
    }

    case '75_300': {
      lines.push(
        `${facts.companyName} has ${facts.openReqCount} roles open right now` +
          `${facts.openEngCount > 0 ? `, ${facts.openEngCount} of them engineering` : ''}` +
          `${facts.staleReqCount > 0 ? `, and ${facts.staleReqCount} have been live longer than 45 days` : ''}.`,
      );
      lines.push('');
      lines.push(
        `The ${facts.reqTitle} req is the one I'd start with — it's been open ${facts.reqDaysOpen} days` +
          `${facts.reqLocation ? ` and it's a ${facts.reqLocation} search` : ''}, which is the profile my desk covers.`,
      );
      lines.push('');
      lines.push(
        `I work with a handful of Bay Area teams on exactly these searches. Contingency, ${fee ? `roughly ${fee} across the roles I'd realistically fill` : 'standard contingency terms'}, ` +
          `and I'm happy to start with one req so you can judge the quality before committing to anything wider.`,
      );
      break;
    }

    default: {
      lines.push(
        `I know a company your size almost certainly has a preferred supplier list, so I'll keep this short.`,
      );
      lines.push('');
      lines.push(
        `Your ${facts.reqTitle} req has been open ${facts.reqDaysOpen} days` +
          `${facts.reqLocation ? ` in ${facts.reqLocation}` : ''}. I run a Bay Area technical desk and I'd like to be considered for the overflow ` +
          `on searches like that one — either through your existing agency process or as a one-off on this req.`,
      );
      break;
    }
  }

  if (facts.fundingStage || facts.ycBatch) {
    const bits = [facts.fundingStage, facts.ycBatch ? `YC ${facts.ycBatch}` : null].filter(Boolean);
    lines.push('');
    lines.push(`(Congratulations on the ${bits.join(' · ')} milestone, by the way.)`);
  }

  return lines.join('\n');
}

function assembleEmail(body: string, signature: string, includeOptOut: boolean): string {
  const parts = [body.trimEnd()];
  if (includeOptOut) parts.push('', OPT_OUT_LINE);
  if (signature.trim()) parts.push('', signature.trim());
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional LLM rewrite — prose only
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = 'claude-opus-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// $5 / $25 per MTok. Budget the reservation generously; the commit writes actuals.
const INPUT_MICROS_PER_TOKEN = 5;
const OUTPUT_MICROS_PER_TOKEN = 25;
const EST_COST_MICROS = 15_000;

const REWRITE_SYSTEM = [
  'You rewrite the body of a single cold outreach email from an independent Bay Area technical recruiter to one hiring decision maker.',
  '',
  'You are given a draft and a set of verified facts. Keep every factual claim exactly as given — do not add numbers, companies, names, dates, or claims that are not in the facts. Do not invent case studies or candidate details.',
  '',
  'Write it the way a competent human recruiter writes when they have actually looked at the company: specific, plain, and short. No "I hope this finds you well", no "I wanted to reach out", no bullet lists, no bold, no markdown, no subject line.',
  '',
  'Output ONLY the body text, starting with the greeting line. Do not include a signature, a sign-off name, a closing salutation, a postscript, a URL, an email address, a phone number, or a calendar link. Those are added separately and anything of that kind in your output causes the whole rewrite to be discarded.',
].join('\n');

/** Anything address-, URL-, or phone-shaped disqualifies the rewrite entirely. */
const CONTACT_SHAPED = /@|https?:\/\/|www\.|\bcalendly\b|\+?\d[\d\s().-]{8,}\d/i;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

/**
 * Returns rewritten prose, or null to fall back to the deterministic body.
 * Never throws for a model-side problem — a failed rewrite must never block a
 * draft the operator could otherwise send.
 */
export async function rewriteBodyProse(
  db: Db,
  facts: DraftFacts,
  deterministicBody: string,
  idempotencyKey: string,
): Promise<{ body: string | null; note: string }> {
  const apiKey = await readSecret(SECRET_ANTHROPIC);
  if (!apiKey) return { body: null, note: 'no anthropic key configured' };

  let reservation;
  try {
    reservation = reserveApiCall(db, {
      provider: 'anthropic',
      endpoint: '/v1/messages',
      idempotencyKey,
      entityType: 'draft',
      entityId: idempotencyKey,
      estCostMicros: EST_COST_MICROS,
      capUsdMicros: Math.round(getSpendCapUsd() * 1_000_000),
    });
  } catch (err) {
    if (err instanceof SpendCapExceeded) return { body: null, note: err.message };
    throw err;
  }
  // Already reserved: this draft was generated before. Do not pay twice.
  if (!reservation) return { body: null, note: 'already generated (ledger hit)' };

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1200,
    system: REWRITE_SYSTEM,
    output_config: { effort: 'low' },
    fallbacks: 'default',
    messages: [
      {
        role: 'user',
        content:
          `Verified facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\n` +
          `Current draft body:\n---\n${deterministicBody}\n---\n\n` +
          `Rewrite the body. Same facts, better sentences.`,
      },
    ],
  };

  const res = await httpRequest(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    timeoutMs: 90_000,
    maxRetries: 1,
  });

  if (!res.ok || !res.body) {
    commitApiCall(db, reservation, {
      ok: false,
      httpStatus: res.status,
      actualCostMicros: 0,
      error: res.error ?? `HTTP ${res.status}`,
    });
    // A transport failure never happened as far as billing is concerned, so free
    // the key rather than permanently blocking a retry for this draft.
    if (res.status === 0) releaseApiCall(db, reservation, 'transport failure');
    return { body: null, note: `anthropic HTTP ${res.status}` };
  }

  let parsed: AnthropicResponse;
  try {
    parsed = JSON.parse(res.body) as AnthropicResponse;
  } catch {
    commitApiCall(db, reservation, { ok: false, httpStatus: res.status, actualCostMicros: 0, error: 'unparseable response' });
    return { body: null, note: 'unparseable anthropic response' };
  }

  const actualMicros =
    (parsed.usage?.input_tokens ?? 0) * INPUT_MICROS_PER_TOKEN +
    (parsed.usage?.output_tokens ?? 0) * OUTPUT_MICROS_PER_TOKEN;

  // Check stop_reason before touching content: a refusal returns 200 with an
  // empty or partial content array.
  if (parsed.stop_reason === 'refusal') {
    commitApiCall(db, reservation, { ok: true, httpStatus: res.status, actualCostMicros: actualMicros, error: 'refusal' });
    return { body: null, note: 'model declined the rewrite' };
  }

  const text = (parsed.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n')
    .trim();

  commitApiCall(db, reservation, { ok: true, httpStatus: res.status, actualCostMicros: actualMicros });

  if (!text) return { body: null, note: 'empty rewrite' };
  // Fail closed. A rewrite carrying anything address-shaped is discarded whole —
  // we never try to strip it out and keep the rest.
  if (CONTACT_SHAPED.test(text)) return { body: null, note: 'rewrite contained contact-shaped text; discarded' };
  if (text.length < 80 || text.length > 4000) return { body: null, note: 'rewrite length out of range' };

  return { body: text, note: `rewritten by ${ANTHROPIC_MODEL}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

interface DraftTarget {
  companyId: string;
  companyName: string;
  headcount: number | null;
  hasInhouseTa: number | null;
  recruiterCount: number | null;
  fundingStage: string | null;
  ycBatch: string | null;
  openReqCount: number;
  openReqEngCount: number;
  staleReqCount: number;
  estimatedFeeUsd: number | null;
  contactId: string;
  contactFullName: string;
  contactFirstName: string | null;
  contactTitle: string | null;
}

export class DraftNotPossible extends Error {}

/**
 * The eligibility query. Two conditions are enforced here rather than in the UI:
 * the company must be approved, and neither the contact's address nor its domain
 * may appear in the suppression table.
 */
function loadTarget(db: Db, companyId: string, contactId?: string): DraftTarget {
  const row = get<DraftTarget>(
    db,
    `SELECT co.id AS companyId, co.name AS companyName, co.headcount, co.has_inhouse_ta AS hasInhouseTa,
            co.recruiter_count AS recruiterCount, co.funding_stage AS fundingStage, co.yc_batch AS ycBatch,
            co.open_req_count AS openReqCount, co.open_req_eng_count AS openReqEngCount,
            co.stale_req_count AS staleReqCount, co.estimated_fee_usd AS estimatedFeeUsd,
            c.id AS contactId, c.full_name AS contactFullName, c.first_name AS contactFirstName,
            c.title AS contactTitle
       FROM company co
       JOIN contact c ON c.company_id = co.id
      WHERE co.id = ?
        AND co.status = 'approved'
        AND co.disqualified IS NULL
        AND c.status != 'rejected'
        AND c.email IS NOT NULL
        AND (? IS NULL OR c.id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM suppression s
           WHERE (s.kind = 'email'   AND lower(s.value) = lower(c.email))
              OR (s.kind = 'domain'  AND lower(s.value) = lower(substr(c.email, instr(c.email, '@') + 1)))
              OR (s.kind = 'company' AND (s.value = co.id OR (co.domain IS NOT NULL AND lower(s.value) = lower(co.domain))))
        )
      ORDER BY c.is_primary DESC, c.contact_score DESC, c.created_at
      LIMIT 1`,
    companyId,
    contactId ?? null,
    contactId ?? null,
  );

  if (!row) {
    throw new DraftNotPossible(
      'No eligible contact: the company must be approved and un-suppressed, and the contact must have an address.',
    );
  }
  return row;
}

/** Pick the req the email is actually about: oldest engineering role, else oldest. */
function pickHeadlineReq(db: Db, companyId: string, now: Date) {
  const reqs = all<Parameters<typeof toReqDomain>[0]>(
    db,
    'SELECT * FROM req WHERE company_id = ? AND closed_at IS NULL',
    companyId,
  ).map(toReqDomain);
  if (reqs.length === 0) return null;

  const ranked = [...reqs].sort((a, b) => {
    const engDelta = Number(isEngineering(b)) - Number(isEngineering(a));
    if (engDelta !== 0) return engDelta;
    const feeDelta = (estimateReqFee(b) ?? 0) - (estimateReqFee(a) ?? 0);
    if (feeDelta !== 0) return feeDelta;
    return daysOpen(b, now) - daysOpen(a, now);
  });
  return ranked[0] ?? null;
}

export interface GeneratedDraft {
  id: string;
  companyId: string;
  contactId: string;
  subject: string;
  body: string;
  reqIds: number[];
  template: string;
  generatedBy: string;
}

/**
 * Create (or regenerate) the draft for one company. Any existing non-skipped
 * draft the operator has not edited is replaced; an edited one is left alone so
 * regeneration can never silently discard their writing.
 */
export async function generateDraftFor(
  db: Db,
  companyId: string,
  contactId?: string,
  opts: { useLlm?: boolean; force?: boolean } = {},
): Promise<GeneratedDraft> {
  const now = new Date();
  const target = loadTarget(db, companyId, contactId);
  const headline = pickHeadlineReq(db, target.companyId, now);
  if (!headline) throw new DraftNotPossible('No open requisition to write about.');

  const existing = get<{ id: string; edited: number; state: string }>(
    db,
    `SELECT id, edited, state FROM draft WHERE contact_id = ? AND state != 'skipped'`,
    target.contactId,
  );
  if (existing && existing.edited === 1 && !opts.force) {
    throw new DraftNotPossible('This draft has operator edits; regenerate explicitly to replace it.');
  }
  if (existing && existing.state !== 'draft' && !opts.force) {
    throw new DraftNotPossible(`Draft is already ${existing.state}.`);
  }

  const sending = getSending();
  const facts: DraftFacts = {
    companyName: target.companyName,
    contactFirstName: firstNameOf(target.contactFirstName, target.contactFullName),
    contactTitle: target.contactTitle,
    band: bandFor(target.headcount),
    headcount: target.headcount,
    reqTitle: headline.title,
    reqDaysOpen: daysOpen(headline, now),
    reqLocation: headline.location,
    reqReposted: headline.repostCount,
    openReqCount: target.openReqCount,
    openEngCount: target.openReqEngCount,
    staleReqCount: target.staleReqCount,
    hasInhouseRecruiter:
      target.hasInhouseTa == null
        ? target.recruiterCount == null
          ? null
          : target.recruiterCount > 0
        : target.hasInhouseTa === 1,
    estimatedFeeUsd: target.estimatedFeeUsd,
    fundingStage: target.fundingStage,
    ycBatch: target.ycBatch,
  };

  const subject = renderSubject(facts);
  const deterministic = renderBody(facts);

  let prose = deterministic;
  let generatedBy = `template:${facts.band}`;
  if (opts.useLlm !== false) {
    const rewrite = await rewriteBodyProse(db, facts, deterministic, `draft:${target.contactId}:${headline.id}`);
    if (rewrite.body) {
      prose = rewrite.body;
      generatedBy = `template:${facts.band}+${ANTHROPIC_MODEL}`;
    }
  }

  const body = assembleEmail(prose, sending.signature, sending.includeOptOutLine);
  const reqIds = [Number(headline.id)];
  const id = existing?.id ?? ulid();

  tx(db, () => {
    if (existing) {
      run(
        db,
        `UPDATE draft SET subject = ?, body = ?, req_ids = ?, template = ?, generated_by = ?, edited = 0,
                          state = 'draft', updated_at = ? WHERE id = ?`,
        subject,
        body,
        JSON.stringify(reqIds),
        facts.band,
        generatedBy,
        Date.now(),
        id,
      );
    } else {
      run(
        db,
        `INSERT INTO draft (id, company_id, contact_id, subject, body, req_ids, template, generated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        target.companyId,
        target.contactId,
        subject,
        body,
        JSON.stringify(reqIds),
        facts.band,
        generatedBy,
        Date.now(),
        Date.now(),
      );
    }
  });

  return {
    id,
    companyId: target.companyId,
    contactId: target.contactId,
    subject,
    body,
    reqIds,
    template: facts.band,
    generatedBy,
  };
}

function firstNameOf(firstName: string | null, fullName: string): string {
  const explicit = firstName?.trim();
  if (explicit) return explicit;
  const head = fullName.trim().split(/\s+/)[0] ?? '';
  return head || 'there';
}

/**
 * Batch pass: every approved company that doesn't already have a draft.
 * Runs one at a time — the LLM rewrite is a paid call and a bounded, visible
 * rate is worth more here than throughput.
 */
export async function generateAllDrafts(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const candidates = all<{ id: string }>(
    db,
    `SELECT co.id FROM company co
      WHERE co.status = 'approved' AND co.disqualified IS NULL AND co.open_req_count > 0
        AND EXISTS (SELECT 1 FROM contact c WHERE c.company_id = co.id AND c.email IS NOT NULL AND c.status != 'rejected')
        AND NOT EXISTS (
          SELECT 1 FROM draft d JOIN contact c2 ON c2.id = d.contact_id
           WHERE c2.company_id = co.id AND d.state != 'skipped'
        )
      ORDER BY co.quality_score DESC, co.estimated_fee_usd DESC`,
  );

  ctx.log('info', `${candidates.length} approved companies without a draft.`);
  ctx.progress(0, candidates.length);

  let made = 0;
  let skipped = 0;

  for (const [index, row] of candidates.entries()) {
    if (ctx.cancelled()) break;
    try {
      await generateDraftFor(db, row.id);
      made++;
    } catch (err) {
      if (err instanceof SpendCapExceeded) {
        ctx.log('warn', `${err.message} — stopping draft generation.`);
        break;
      }
      skipped++;
      if (!(err instanceof DraftNotPossible)) {
        ctx.log('warn', `Draft failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    ctx.progress(index + 1, candidates.length);
  }

  return { records: made, message: `${made} drafts generated, ${skipped} skipped` };
}
