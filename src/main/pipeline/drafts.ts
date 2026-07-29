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
import { getSending, getSpendCapUsd, getTemplates, readSecret, SECRET_ANTHROPIC } from '../settings.js';
import { assembleEmail, renderTemplate, type TemplateVars } from '../../shared/outreach.js';
import { reserveApiCall, commitApiCall, releaseApiCall, SpendCapExceeded } from './tasks.js';
import { daysOpen, estimateReqFee, isEngineering } from '../../shared/score.js';
import { toReqDomain } from './scoring.js';
import { COMPANY_SUPPRESSION_MATCH } from './suppression.js';
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
/**
 * Age of a requisition as a phrase, or null when the number would undercut the
 * message. A req first seen today reports 0 days — saying "open 0 days" to a
 * hiring manager reads as broken software, and "1 days" reads as careless.
 * Below a week there is no staleness story to tell, so the clause is dropped
 * rather than fudged.
 */
export function daysOpenPhrase(days: number | null | undefined): string | null {
  if (days == null || !Number.isFinite(days) || days < 7) return null;
  const n = Math.floor(days);
  return `open ${n} day${n === 1 ? '' : 's'}`;
}

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
      {
        const age = daysOpenPhrase(facts.reqDaysOpen);
        const where = facts.reqLocation ? `a ${facts.reqLocation} search` : null;
        const detail = [age ? `it's been ${age}` : null, where ? `it's ${where}` : null]
          .filter(Boolean)
          .join(' and ');
        lines.push(
          `The ${facts.reqTitle} req is the one I'd start with` +
            (detail ? ` — ${detail}` : '') +
            (where ? ', which is the profile my desk covers.' : '.'),
        );
      }
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
      {
        const age = daysOpenPhrase(facts.reqDaysOpen);
        lines.push(
          `Your ${facts.reqTitle} req${age ? ` has been ${age}` : ' is open'}` +
            `${facts.reqLocation ? ` in ${facts.reqLocation}` : ''}. I run a Bay Area technical desk and I'd like to be considered for the overflow ` +
            `on searches like that one — either through your existing agency process or as a one-off on this req.`,
        );
      }
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


// ─────────────────────────────────────────────────────────────────────────────
// Follow-ups
// ─────────────────────────────────────────────────────────────────────────────

/** Give a first send at least this long before bumping the thread. */
export const FOLLOW_UP_MIN_AGE_MS = 2 * 86_400_000;

/**
 * A short, deterministic bump for a sent-and-silent message. Threads onto the
 * original send at send time (sendOne reads follow_up_of → thread id and
 * Message-ID). Deliberately not LLM-rewritten: a two-sentence bump has no
 * facts to embellish, and embellishment is the only thing a model would add.
 */
export async function followUpDraftFor(db: Db, sendId: string): Promise<GeneratedDraft> {
  const send = get<{
    id: string;
    company_id: string;
    contact_id: string;
    subject: string;
    sent_at: number | null;
    outcome: string;
    contact_status: string;
    first_name: string | null;
    full_name: string;
    company_name: string;
  }>(
    db,
    `SELECT s.id, s.company_id, s.contact_id, s.subject, s.sent_at, s.outcome,
            c.status AS contact_status, c.first_name, c.full_name, co.name AS company_name
       FROM send s
       JOIN contact c ON c.id = s.contact_id
       JOIN company co ON co.id = s.company_id
      WHERE s.id = ?`,
    sendId,
  );
  if (!send) throw new DraftNotPossible('Unknown send.');
  if (send.outcome === 'replied') {
    throw new DraftNotPossible('They replied — answer the thread, don’t bump it.');
  }
  if (send.outcome === 'bounced') {
    throw new DraftNotPossible('The address bounced; a follow-up cannot arrive.');
  }
  if (send.outcome !== 'sent' && send.outcome !== 'silent') {
    throw new DraftNotPossible('Only a delivered message can be followed up.');
  }
  if (send.contact_status === 'rejected' || send.contact_status === 'bounced') {
    throw new DraftNotPossible('This contact is closed.');
  }
  // The person, not just this thread: a reply marked on any of their sends
  // means they answered — bumping a parallel thread reads as ignoring them.
  if (send.contact_status === 'replied') {
    throw new DraftNotPossible('They already replied — answer that thread instead of bumping this one.');
  }
  if (send.sent_at != null && Date.now() - send.sent_at < FOLLOW_UP_MIN_AGE_MS) {
    throw new DraftNotPossible('Sent less than two days ago — give them room to answer first.');
  }

  // Two bumps per person is the ceiling. A third unanswered email is not
  // persistence, it is the thing suppression lists exist for.
  const bumps = get<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM send s2 JOIN draft d2 ON d2.id = s2.draft_id
      WHERE s2.contact_id = ? AND d2.follow_up_of IS NOT NULL
        AND s2.outcome IN ('sent','silent','replied','bounced')`,
    send.contact_id,
  );
  if ((bumps?.n ?? 0) >= 2) {
    throw new DraftNotPossible('Two follow-ups have already gone out — time to move on.');
  }

  const active = get<{ id: string }>(
    db,
    `SELECT id FROM draft WHERE contact_id = ? AND state IN ('draft','queued','sending')`,
    send.contact_id,
  );
  if (active) throw new DraftNotPossible('An active draft for this person already exists.');

  // A FAILED follow-up still owns the intent: requeueing it later would
  // collide with a second one on the active-draft index.
  const failedBump = get<{ id: string }>(
    db,
    `SELECT id FROM draft WHERE contact_id = ? AND state = 'failed' AND follow_up_of IS NOT NULL`,
    send.contact_id,
  );
  if (failedBump) {
    throw new DraftNotPossible('A failed follow-up already exists — requeue or skip it first.');
  }

  // Honesty rule: no open req, no claim to make, no bump.
  const now = new Date();
  const headline = pickHeadlineReq(db, send.company_id, now);
  if (!headline) {
    throw new DraftNotPossible('The roles this thread was about have closed — nothing truthful left to bump.');
  }

  const sending = getSending();
  const first = firstNameOf(send.first_name, send.full_name);
  const days = daysOpen(headline, now);

  const lines = [
    `Hi ${first},`,
    '',
    `Floating this back up — your ${headline.title} search still shows open${days > 0 ? ` (${days} days now)` : ''}. ` +
      `Happy to send over two or three profiles whenever it would be useful.`,
  ];

  const subject = /^re:/i.test(send.subject) ? send.subject : `Re: ${send.subject}`;
  const body = assembleEmail(lines.join('\n'), {
    signature: sending.signature,
    includeOptOutLine: sending.includeOptOutLine,
    postalAddress: sending.postalAddress,
  });

  const id = ulid();
  try {
    run(
      db,
      `INSERT INTO draft (id, company_id, contact_id, subject, body, req_ids, template, generated_by, follow_up_of, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'follow_up', 'followup:deterministic', ?, ?, ?)`,
      id,
      send.company_id,
      send.contact_id,
      subject,
      body,
      JSON.stringify([Number(headline.id)]),
      sendId,
      Date.now(),
      Date.now(),
    );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: draft\.contact_id/.test(err.message)) {
      throw new DraftNotPossible('A draft for this person was just created elsewhere.');
    }
    throw err;
  }

  return {
    id,
    companyId: send.company_id,
    contactId: send.contact_id,
    subject,
    body,
    reqIds: [Number(headline.id)],
    template: 'follow_up',
    generatedBy: 'followup:deterministic',
  };
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
    // Paid calls never auto-retry: a retried request that already completed
    // server-side bills twice (same invariant as the verifier's PAID_HTTP).
    maxRetries: 0,
  });

  if (!res.ok || !res.body) {
    // A refused call (429/5xx/connection failure) consumed no credit — release
    // the reservation so a later pass can retry. A client-side TIMEOUT is the
    // one failure that MAY have completed and billed server-side, so it commits
    // a failed row instead: one at-risk credit, never an unbounded ledger-
    // invisible retry loop. (The old code committed first and then tried to
    // release, which never matched — every blip locked the draft forever.)
    const maybeBilled = res.status === 0 && /abort|timeout/i.test(res.error ?? '');
    if (maybeBilled) {
      commitApiCall(db, reservation, {
        ok: false,
        httpStatus: 0,
        actualCostMicros: 0,
        error: `timeout — response unknown, possibly billed: ${res.error ?? ''}`,
      });
    } else {
      releaseApiCall(db, reservation, res.error ?? `HTTP ${res.status}`);
    }
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
           WHERE (s.kind = 'email'   AND s.value = lower(c.email))
              OR (s.kind = 'domain'  AND s.value = lower(substr(c.email, instr(c.email, '@') + 1)))
              OR (s.kind = 'company' AND ${COMPANY_SUPPRESSION_MATCH})
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

  // One ACTIVE draft per contact (unique index). A sent row no longer blocks
  // the slot — follow-ups are new rows — so the lookup is tiered: an active
  // row is replaced in place, a failed one is reused, a sent one only guards.
  const active = get<{ id: string; edited: number; state: string; follow_up_of: string | null }>(
    db,
    `SELECT id, edited, state, follow_up_of FROM draft WHERE contact_id = ? AND state IN ('draft','queued','sending')`,
    target.contactId,
  );
  // Mid-send is untouchable, force included: the claimed Gmail call is in
  // flight and its success path stamps whatever row content 'sent'.
  if (active && active.state === 'sending') {
    throw new DraftNotPossible('This draft is being sent right now.');
  }
  // A follow-up is never regenerated into a cold pitch — force included. The
  // replacement would keep (or worse, silently carry) the threading intent
  // while the copy stops being a reply. Skip it first if a fresh cold email
  // is genuinely wanted.
  if (active && active.follow_up_of) {
    throw new DraftNotPossible('An active follow-up exists for this person — edit it, or skip it first.');
  }
  if (active && active.edited === 1 && !opts.force) {
    throw new DraftNotPossible('This draft has operator edits; regenerate explicitly to replace it.');
  }
  if (active && active.state !== 'draft' && !opts.force) {
    throw new DraftNotPossible(`Draft is already ${active.state}.`);
  }

  const failed = active
    ? null
    : get<{ id: string; edited: number; state: string }>(
        db,
        `SELECT id, edited, state FROM draft WHERE contact_id = ? AND state = 'failed' ORDER BY updated_at DESC LIMIT 1`,
        target.contactId,
      );

  if (!active && !failed && !opts.force) {
    const sent = get<{ id: string }>(
      db,
      `SELECT id FROM draft WHERE contact_id = ? AND state = 'sent' LIMIT 1`,
      target.contactId,
    );
    if (sent) {
      throw new DraftNotPossible('Already sent to this person — use Follow up on the Sent tab instead.');
    }
  }

  const existing = active ?? failed;

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

  // Operator template overrides (Settings → Templates) take precedence over
  // the built-in renderers. Variables come from the same DraftFacts; a line
  // whose variable has no value is dropped, exactly like the built-ins.
  const override = getTemplates()[facts.band];
  const vars: TemplateVars = {
    firstName: facts.contactFirstName,
    companyName: facts.companyName,
    reqTitle: facts.reqTitle,
    reqDaysOpen: facts.reqDaysOpen,
    reqLocation: facts.reqLocation,
    openReqCount: facts.openReqCount,
    openEngCount: facts.openEngCount,
    staleReqCount: facts.staleReqCount,
    fee: facts.estimatedFeeUsd != null ? usd(facts.estimatedFeeUsd) : null,
    fundingStage: facts.fundingStage,
    ycBatch: facts.ycBatch,
  };
  const customSubject = override.subject.trim() ? renderTemplate(override.subject, vars) : '';
  const customBody = override.body.trim() ? renderTemplate(override.body, vars) : '';

  const subject = customSubject || renderSubject(facts);
  const deterministic = customBody || renderBody(facts);

  let prose = deterministic;
  let generatedBy = customBody ? `custom:${facts.band}` : `template:${facts.band}`;
  if (opts.useLlm !== false) {
    // Force is a deliberate re-purchase: without a fresh key, every forced
    // regenerate silently fell back to the deterministic body forever
    // ("already generated" ledger hit) — the paid prose was unreachable.
    // Max-suffix, not count: this ledger DELETES released reservations, so a
    // count-based suffix could recompute an existing key after a refusal and
    // wedge every future force into the ledger-hit path.
    const baseKey = `draft:${target.contactId}:${headline.id}`;
    let rewriteKey = baseKey;
    if (opts.force) {
      const keys = all<{ idempotency_key: string }>(
        db,
        `SELECT idempotency_key FROM api_call WHERE provider = 'anthropic' AND (idempotency_key = ? OR idempotency_key LIKE ?)`,
        baseKey,
        `${baseKey}#%`,
      );
      if (keys.length > 0) {
        const maxSuffix = Math.max(
          1,
          ...keys.map((k) => {
            const m = /#(\d+)$/.exec(k.idempotency_key);
            return m ? Number(m[1]) : 1;
          }),
        );
        rewriteKey = `${baseKey}#${maxSuffix + 1}`;
      }
    }
    const rewrite = await rewriteBodyProse(db, facts, deterministic, rewriteKey);
    if (rewrite.body) {
      prose = rewrite.body;
      generatedBy = `${generatedBy}+${ANTHROPIC_MODEL}`;
    }
  }

  const body = assembleEmail(prose, {
    signature: sending.signature,
    includeOptOutLine: sending.includeOptOutLine,
    postalAddress: sending.postalAddress,
  });
  const reqIds = [Number(headline.id)];
  const id = existing?.id ?? ulid();

  try {
    writeDraftRow();
  } catch (err) {
    // Concurrent generation (drainer task + operator click) both passing the
    // active-check resolves here via the unique index — surface it as the
    // ordinary "someone got there first", not a raw SQLITE_CONSTRAINT.
    if (err instanceof Error && /UNIQUE constraint failed: draft\.contact_id/.test(err.message)) {
      throw new DraftNotPossible('A draft for this person was just created elsewhere — refresh and edit that one.');
    }
    throw err;
  }

  function writeDraftRow(): void {
  tx(db, () => {
    if (existing) {
      run(
        db,
        `UPDATE draft SET subject = ?, body = ?, req_ids = ?, template = ?, generated_by = ?, edited = 0,
                          state = 'draft', follow_up_of = NULL, scheduled_at = NULL, updated_at = ? WHERE id = ?`,
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
  }

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
