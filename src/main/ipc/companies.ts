/**
 * Company and contact IPC handlers.
 *
 * The list query is the hot path of the whole app — the operator lives in it for
 * ~40 hours per pass — so it is built as one SQL statement with correlated
 * subqueries rather than N+1 round trips, and search goes through the req FTS5
 * index instead of a LIKE scan over job descriptions.
 */

import { handle } from './guard.js';
import { getDb, all, get, run, tx, ulid, type Db } from '../db/index.js';
import {
  observeCompany,
  observeContact,
  writeObservation,
  resolveEntityField,
  applyCompanyColumn,
  applyContactColumn,
  companyFieldColumns,
  contactFieldColumns,
  canonicalCompanyId,
  etldPlusOne,
} from '../pipeline/ingest.js';
import { recomputeCompany, electPrimaryContact } from '../pipeline/scoring.js';
import { enqueue } from '../pipeline/tasks.js';
import { TASK_GENERATE_DRAFT } from '../pipeline/drain.js';
import { emitEvent } from '../pipeline/run.js';
import { discoverContacts, verifyContactById } from '../pipeline/contacts.js';
import type {
  CompanyDetail,
  CompanyListParams,
  CompanyPatch,
  CompanyRow,
  ContactPatch,
  ContactRow,
  ReqRow,
  ResolvedField,
  ScreenshotRow,
} from '../../shared/ipc.js';
import type { ScoreComponent } from '../../shared/score.js';
import type { AtsPlatform, Persona, VerificationVerdict } from '../../shared/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// listCompanies
// ─────────────────────────────────────────────────────────────────────────────

const LIST_COLUMNS = `
  c.id, c.name, c.domain, c.headcount, c.industry,
  c.quality_score AS qualityScore, c.score_headline AS scoreHeadline,
  c.open_req_count AS openReqCount, c.open_req_eng_count AS openReqEngCount,
  c.stale_req_count AS staleReqCount, c.max_days_open AS maxDaysOpen,
  c.estimated_fee_usd AS estimatedFeeUsd, c.has_inhouse_ta AS hasInhouseTa,
  c.recruiter_count AS recruiterCount, c.disqualified, c.status,
  c.reviewed, c.yc_batch AS ycBatch, c.ats_platform AS atsPlatform,
  (SELECT count(*) FROM contact ct WHERE ct.company_id = c.id) AS contactCount,
  (SELECT count(*) FROM contact ct WHERE ct.company_id = c.id AND ct.email_verdict = 'valid') AS verifiedContactCount,
  EXISTS (SELECT 1 FROM field_resolved fr
           WHERE fr.entity = 'company' AND fr.entity_id = c.id AND fr.conflicting = 1) AS hasConflict
`;

interface CompanyRowRaw extends Omit<CompanyRow, 'hasInhouseTa' | 'hasConflict' | 'reviewed' | 'atsPlatform'> {
  hasInhouseTa: number | null;
  hasConflict: number;
  reviewed: number;
  atsPlatform: string | null;
}

function toCompanyRow(r: CompanyRowRaw): CompanyRow {
  return {
    ...r,
    hasInhouseTa: r.hasInhouseTa == null ? null : r.hasInhouseTa === 1,
    hasConflict: r.hasConflict === 1,
    reviewed: r.reviewed === 1,
    atsPlatform: (r.atsPlatform as AtsPlatform | null) ?? null,
  };
}

/**
 * FTS5 MATCH syntax is user-hostile — a stray quote or a `-` is a syntax error,
 * not an empty result. Tokenise to alphanumerics and rebuild a prefix query so
 * anything the operator types is safe.
 */
function ftsQuery(search: string): string | null {
  const terms = search.toLowerCase().match(/[a-z0-9]+/g);
  if (!terms || terms.length === 0) return null;
  return terms
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(' AND ');
}

const SORTS: Record<NonNullable<CompanyListParams['sort']>, string> = {
  score: 'c.quality_score IS NULL, c.quality_score DESC, c.open_req_count DESC, c.id',
  reqs: 'c.open_req_count DESC, c.quality_score DESC, c.id',
  days_open: 'c.max_days_open IS NULL, c.max_days_open DESC, c.quality_score DESC, c.id',
  recent: 'c.created_at DESC, c.id',
  name: 'c.name_norm ASC, c.id',
  fee: 'c.estimated_fee_usd IS NULL, c.estimated_fee_usd DESC, c.id',
};

export function listCompanies(db: Db, params: CompanyListParams = {}): CompanyRow[] {
  const where: string[] = ['c.canonical_id IS NULL'];
  const args: unknown[] = [];

  switch (params.filter ?? 'all') {
    case 'unreviewed':
      where.push('c.reviewed = 0');
      break;
    case 'conflicts':
      where.push(
        `EXISTS (SELECT 1 FROM field_resolved fr WHERE fr.entity = 'company' AND fr.entity_id = c.id AND fr.conflicting = 1)`,
      );
      break;
    case 'approved':
      where.push(`c.status = 'approved'`);
      break;
    case 'rejected':
      where.push(`c.status IN ('rejected','suppressed')`);
      break;
    default:
      break;
  }

  const search = params.search?.trim();
  if (search) {
    // Backslash first: it is the ESCAPE character, so a literal '\' in the
    // search would otherwise neuter whichever wildcard follows it.
    const like = `%${search.replace(/\\/g, '\\\\').replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const fts = ftsQuery(search);
    const clauses = [
      `c.name LIKE ? ESCAPE '\\'`,
      `c.domain LIKE ? ESCAPE '\\'`,
      `EXISTS (SELECT 1 FROM contact ct WHERE ct.company_id = c.id AND (ct.full_name LIKE ? ESCAPE '\\' OR ct.email LIKE ? ESCAPE '\\'))`,
    ];
    args.push(like, like, like, like);
    if (fts) {
      // Decorrelated on purpose: IN (…) runs the FTS MATCH once for the whole
      // query. The correlated form (`req_fts MATCH ? AND r.company_id = c.id`)
      // re-executed the match per candidate row — measured 11–23 s per
      // keystroke at 10k companies vs ~100 ms for this shape.
      clauses.push(
        `c.id IN (SELECT r.company_id FROM req r JOIN req_fts ON req_fts.rowid = r.id WHERE req_fts MATCH ?)`,
      );
      args.push(fts);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  if (params.hasVerifiedEmail) {
    where.push(`EXISTS (SELECT 1 FROM contact ct WHERE ct.company_id = c.id AND ct.email_verdict = 'valid')`);
  }
  if (params.noInhouseTa) {
    where.push('(c.has_inhouse_ta = 0 OR c.recruiter_count = 0)');
  }
  if (params.staleOnly) {
    where.push('c.stale_req_count > 0');
  }

  const orderBy = SORTS[params.sort ?? 'score'] ?? SORTS.score;
  // 1,000,000 matches the schema cap: the renderer deliberately loads the
  // whole list (virtualized). A 5,000 clamp silently hid companies past it.
  const limit = clampInt(params.limit, 1, 1_000_000, 200);
  const offset = clampInt(params.offset, 0, 1_000_000, 0);

  const sql =
    `SELECT ${LIST_COLUMNS} FROM company c WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  args.push(limit, offset);

  return all<CompanyRowRaw>(db, sql, ...args).map(toCompanyRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// getCompany
// ─────────────────────────────────────────────────────────────────────────────

interface ReqRowRaw {
  id: number;
  title: string;
  department: string | null;
  team: string | null;
  location: string | null;
  is_remote: number | null;
  comp_min: number | null;
  comp_max: number | null;
  estimated_fee_usd: number | null;
  days_open: number | null;
  repost_count: number;
  url: string;
  published_at: number | null;
  closed_at: number | null;
  function_family: string | null;
  seniority: string | null;
  no_agency_disclaimer: number | null;
  named_contact: string | null;
  description: string | null;
}

interface ContactRowRaw {
  id: string;
  companyId: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  persona: string | null;
  email: string | null;
  emailVerdict: VerificationVerdict;
  emailVerifiedAt: number | null;
  emailSource: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  isPrimary: number;
  contactScore: number | null;
  status: string;
  reviewed: number;
  notes: string | null;
}

const CONTACT_SELECT = `
  id, company_id AS companyId, full_name AS fullName, first_name AS firstName, last_name AS lastName,
  title, persona, email, email_verdict AS emailVerdict, email_verified_at AS emailVerifiedAt,
  email_source AS emailSource, phone, linkedin_url AS linkedinUrl, is_primary AS isPrimary,
  contact_score AS contactScore, status, reviewed, notes
`;

function toContactRow(r: ContactRowRaw): ContactRow {
  return {
    ...r,
    persona: (r.persona as Persona | null) ?? null,
    isPrimary: r.isPrimary === 1,
    reviewed: r.reviewed === 1,
  };
}

function toReqRow(r: ReqRowRaw): ReqRow {
  return {
    id: r.id,
    title: r.title,
    department: r.department,
    team: r.team,
    location: r.location,
    isRemote: r.is_remote == null ? null : r.is_remote === 1,
    compMin: r.comp_min,
    compMax: r.comp_max,
    estimatedFeeUsd: r.estimated_fee_usd,
    daysOpen: r.days_open,
    repostCount: r.repost_count,
    url: r.url,
    publishedAt: r.published_at,
    closedAt: r.closed_at,
    functionFamily: r.function_family,
    seniority: r.seniority,
    noAgencyDisclaimer: r.no_agency_disclaimer == null ? null : r.no_agency_disclaimer === 1,
    namedContact: r.named_contact,
    description: r.description,
  };
}

/** Winning value per field, plus every competing observation behind it. */
export function resolvedFieldsFor(db: Db, entity: 'company' | 'contact', entityId: string): ResolvedField[] {
  const resolved = all<{ field: string; value: string | null; source: string; confidence: ResolvedField['confidence']; conflicting: number }>(
    db,
    `SELECT field, value, source, confidence, conflicting FROM field_resolved
      WHERE entity = ? AND entity_id = ? ORDER BY field`,
    entity,
    entityId,
  );
  if (resolved.length === 0) return [];

  const observations = all<{
    id: number;
    field: string;
    value: string | null;
    source: string;
    confidence: string;
    observed_at: number;
    evidence_id: number | null;
  }>(
    db,
    `SELECT id, field, value, source, confidence, observed_at, evidence_id
       FROM field_observation
      WHERE entity = ? AND entity_id = ?
      ORDER BY field, observed_at DESC, id DESC`,
    entity,
    entityId,
  );

  const byField = new Map<string, ResolvedField['observations']>();
  for (const o of observations) {
    let list = byField.get(o.field);
    if (!list) {
      list = [];
      byField.set(o.field, list);
    }
    list.push({
      id: o.id,
      value: o.value,
      source: o.source,
      confidence: o.confidence,
      observedAt: o.observed_at,
      evidenceId: o.evidence_id,
    });
  }

  return resolved.map((r) => ({
    field: r.field,
    value: r.value,
    source: r.source,
    confidence: r.confidence,
    conflicting: r.conflicting === 1,
    observations: byField.get(r.field) ?? [],
  }));
}

export function getCompany(db: Db, id: string): CompanyDetail | null {
  const companyId = canonicalCompanyId(db, id);
  const base = get<CompanyRowRaw>(db, `SELECT ${LIST_COLUMNS} FROM company c WHERE c.id = ?`, companyId);
  if (!base) return null;

  const extra = get<{
    website: string | null;
    careersUrl: string | null;
    linkedinUrl: string | null;
    hqLocation: string | null;
    fundingStage: string | null;
    lastRoundAt: number | null;
    scoreRaw: number | null;
    scoreBreakdown: string | null;
    notes: string | null;
    createdAt: number;
    updatedAt: number;
  }>(
    db,
    `SELECT website, careers_url AS careersUrl, linkedin_url AS linkedinUrl, hq_location AS hqLocation,
            funding_stage AS fundingStage, last_round_at AS lastRoundAt, score_raw AS scoreRaw,
            score_breakdown AS scoreBreakdown, notes, created_at AS createdAt, updated_at AS updatedAt
       FROM company WHERE id = ?`,
    companyId,
  );

  const reqs = all<ReqRowRaw>(
    db,
    `SELECT id, title, department, team, location, is_remote, comp_min, comp_max, estimated_fee_usd,
            days_open, repost_count, url, published_at, closed_at, function_family, seniority,
            no_agency_disclaimer, named_contact, description
       FROM req WHERE company_id = ?
      ORDER BY (closed_at IS NOT NULL), days_open DESC, id`,
    companyId,
  ).map(toReqRow);

  const contactRows = all<ContactRowRaw>(
    db,
    `SELECT ${CONTACT_SELECT} FROM contact WHERE company_id = ?
      ORDER BY is_primary DESC, contact_score DESC, created_at`,
    companyId,
  ).map(toContactRow);

  const screenshots = all<{
    id: string;
    kind: string;
    relPath: string;
    url: string | null;
    width: number | null;
    height: number | null;
    capturedAt: number;
  }>(
    db,
    `SELECT id, kind, rel_path AS relPath, url, width, height, captured_at AS capturedAt
       FROM screenshot WHERE entity = 'company' AND entity_id = ? ORDER BY captured_at DESC`,
    companyId,
  ) as ScreenshotRow[];

  let breakdown: ScoreComponent[] = [];
  if (extra?.scoreBreakdown) {
    try {
      const parsed = JSON.parse(extra.scoreBreakdown);
      if (Array.isArray(parsed)) breakdown = parsed as ScoreComponent[];
    } catch {
      breakdown = [];
    }
  }

  return {
    ...toCompanyRow(base),
    website: extra?.website ?? null,
    careersUrl: extra?.careersUrl ?? null,
    linkedinUrl: extra?.linkedinUrl ?? null,
    hqLocation: extra?.hqLocation ?? null,
    fundingStage: extra?.fundingStage ?? null,
    lastRoundAt: extra?.lastRoundAt ?? null,
    scoreRaw: extra?.scoreRaw ?? null,
    scoreBreakdown: breakdown,
    notes: extra?.notes ?? null,
    reqs,
    contacts: contactRows,
    fields: resolvedFieldsFor(db, 'company', companyId),
    screenshots,
    createdAt: extra?.createdAt ?? 0,
    updatedAt: extra?.updatedAt ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export function auditLog(
  db: Db,
  entry: {
    actor: string;
    action: string;
    entity: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    note?: string | null;
  },
): void {
  run(
    db,
    `INSERT INTO audit_log (at, actor, action, entity, entity_id, before_json, after_json, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(),
    entry.actor,
    entry.action,
    entry.entity,
    entry.entityId,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.note ?? null,
  );
}

/** Patch keys that describe the world (observed) versus keys that describe our workflow. */
const COMPANY_STATE_KEYS = new Set(['notes', 'status', 'reviewed']);
const CONTACT_STATE_KEYS = new Set(['notes', 'status', 'reviewed', 'isPrimary']);

const COMPANY_STATUSES = new Set(['discovered', 'enriched', 'scored', 'approved', 'rejected', 'suppressed']);
const CONTACT_STATUSES = new Set(['candidate', 'approved', 'rejected', 'contacted', 'replied', 'bounced']);

/**
 * Operator edits are observations, not overwrites. The prior value stays in
 * field_observation forever; the human row simply outranks every source, which
 * is also what clears the conflict flag on that field.
 */
export function patchCompany(db: Db, id: string, patch: CompanyPatch): CompanyDetail {
  const companyId = canonicalCompanyId(db, id);
  const before = get<Record<string, unknown>>(db, 'SELECT * FROM company WHERE id = ?', companyId);
  if (!before) throw new Error(`Unknown company: ${id}`);

  const columns = companyFieldColumns();

  tx(db, () => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      if (COMPANY_STATE_KEYS.has(key)) {
        if (key === 'notes') {
          run(db, 'UPDATE company SET notes = ?, updated_at = ? WHERE id = ?', asText(value), Date.now(), companyId);
        } else if (key === 'status') {
          const status = String(value);
          if (!COMPANY_STATUSES.has(status)) throw new Error(`Invalid company status: ${status}`);
          run(db, 'UPDATE company SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), companyId);
          // Approving is what makes a company draftable. Enqueue rather than
          // generate inline: drafting may call an LLM, and the approve keystroke
          // is the hot path of the review loop. dedupe_key keeps repeated
          // approve/unapprove from stacking duplicate work.
          if (status === 'approved') {
            enqueue(db, TASK_GENERATE_DRAFT, { companyId }, { dedupeKey: companyId, priority: 50 });
          }
        } else if (key === 'reviewed') {
          const reviewed = value === true ? 1 : 0;
          run(
            db,
            'UPDATE company SET reviewed = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
            reviewed,
            reviewed ? Date.now() : null,
            Date.now(),
            companyId,
          );
        }
        continue;
      }

      if (!(key in columns)) continue;
      const normalised = key === 'domain' && typeof value === 'string' ? etldPlusOne(value) ?? value.trim() : value;
      observeCompany(db, companyId, key, normalised as string | number | boolean | null, 'human', null, 'high');
    }

    auditLog(db, {
      actor: 'operator',
      action: 'patchCompany',
      entity: 'company',
      entityId: companyId,
      before: pick(before, Object.keys(patch)),
      after: patch,
    });

    recomputeCompany(db, companyId);
  });

  emitEvent('data:changed', { entity: 'company', id: companyId });
  return getCompany(db, companyId)!;
}

export function bulkCompanyStatus(db: Db, ids: string[], status: string): number {
  if (!COMPANY_STATUSES.has(status)) throw new Error(`Invalid company status: ${status}`);
  if (ids.length === 0) return 0;

  let changed = 0;
  const updatedIds: string[] = [];
  tx(db, () => {
    for (const rawId of ids) {
      const companyId = canonicalCompanyId(db, rawId);
      const before = get<{ status: string }>(db, 'SELECT status FROM company WHERE id = ?', companyId);
      if (!before) continue;
      // Already in the target status: nothing changed, so no audit row and —
      // crucially — no draft task (re-approving an already-contacted company
      // would only feed the drainer a guaranteed "already sent" refusal).
      if (before.status === status) continue;
      updatedIds.push(companyId);
      run(
        db,
        'UPDATE company SET status = ?, reviewed = 1, reviewed_at = ?, updated_at = ? WHERE id = ?',
        status,
        Date.now(),
        Date.now(),
        companyId,
      );
      auditLog(db, {
        actor: 'operator',
        action: 'bulkCompanyStatus',
        entity: 'company',
        entityId: companyId,
        before: { status: before.status },
        after: { status },
      });
      changed++;
    }
  });

  emitEvent('data:changed', { entity: 'company' });
  if (status === 'approved') {
    // Only ids that actually updated — raw/merged-away ids would enqueue
    // draft tasks that fail through every retry into dead-letter noise.
    for (const id of updatedIds) {
      enqueue(db, TASK_GENERATE_DRAFT, { companyId: id }, { dedupeKey: id, priority: 50 });
    }
  }

  return changed;
}

/**
 * Record the operator's pick as a human observation carrying the chosen value.
 * That makes the decision durable — a later fetch from the losing source cannot
 * silently re-open the conflict, because human outranks everything.
 */
export function resolveConflict(db: Db, entityId: string, field: string, observationId: number): void {
  const obs = get<{ entity: 'company' | 'contact' | 'req'; entity_id: string; field: string; value: string | null; evidence_id: number | null }>(
    db,
    'SELECT entity, entity_id, field, value, evidence_id FROM field_observation WHERE id = ?',
    observationId,
  );
  if (!obs) throw new Error(`Unknown observation: ${observationId}`);
  if (obs.entity_id !== entityId || obs.field !== field) {
    throw new Error('That observation does not belong to this field.');
  }

  tx(db, () => {
    writeObservation(db, obs.entity, entityId, field, obs.value, 'human', obs.evidence_id, 'high');
    const winner = resolveEntityField(db, obs.entity, entityId, field);
    if (winner) {
      if (obs.entity === 'company') applyCompanyColumn(db, entityId, field, winner.value);
      if (obs.entity === 'contact') applyContactColumn(db, entityId, field, winner.value);
    }
    run(
      db,
      `UPDATE field_resolved SET conflicting = 0, resolved_at = ? WHERE entity = ? AND entity_id = ? AND field = ?`,
      Date.now(),
      obs.entity,
      entityId,
      field,
    );
    auditLog(db, {
      actor: 'operator',
      action: 'resolveConflict',
      entity: obs.entity,
      entityId,
      after: { field, chosenObservationId: observationId, value: obs.value },
    });
  });

  if (obs.entity === 'company') {
    recomputeCompany(db, entityId);
    emitEvent('data:changed', { entity: 'company', id: entityId });
  } else {
    emitEvent('data:changed', { entity: 'contact', id: entityId });
  }
}

export function patchContact(db: Db, id: string, patch: ContactPatch): ContactRow {
  const before = get<Record<string, unknown> & { company_id: string; email: string | null }>(
    db,
    'SELECT * FROM contact WHERE id = ?',
    id,
  );
  if (!before) throw new Error(`Unknown contact: ${id}`);

  const columns = contactFieldColumns();

  tx(db, () => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      if (CONTACT_STATE_KEYS.has(key)) {
        if (key === 'notes') {
          run(db, 'UPDATE contact SET notes = ?, updated_at = ? WHERE id = ?', asText(value), Date.now(), id);
        } else if (key === 'status') {
          const status = String(value);
          if (!CONTACT_STATUSES.has(status)) throw new Error(`Invalid contact status: ${status}`);
          run(db, 'UPDATE contact SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), id);
        } else if (key === 'reviewed') {
          run(db, 'UPDATE contact SET reviewed = ?, updated_at = ? WHERE id = ?', value === true ? 1 : 0, Date.now(), id);
        } else if (key === 'isPrimary') {
          if (value === true) {
            run(db, 'UPDATE contact SET is_primary = 0 WHERE company_id = ?', before.company_id);
            run(db, 'UPDATE contact SET is_primary = 1, reviewed = 1, updated_at = ? WHERE id = ?', Date.now(), id);
          } else {
            run(db, 'UPDATE contact SET is_primary = 0, updated_at = ? WHERE id = ?', Date.now(), id);
          }
        }
        continue;
      }

      if (!(key in columns)) continue;
      observeContact(db, id, key, value as string | number | boolean | null, 'human', null, 'high');

      // A hand-typed address has never been verified. Reset the verdict rather
      // than carrying the old one over onto a different mailbox.
      if (key === 'email' && String(value ?? '').trim().toLowerCase() !== String(before.email ?? '').toLowerCase()) {
        run(
          db,
          `UPDATE contact SET email_source = 'human', email_verdict = 'unverified', email_verified_at = NULL,
                              email_pattern = NULL, updated_at = ? WHERE id = ?`,
          Date.now(),
          id,
        );
      }
    }

    auditLog(db, {
      actor: 'operator',
      action: 'patchContact',
      entity: 'contact',
      entityId: id,
      before: pick(before, Object.keys(patch)),
      after: patch,
    });

    recomputeCompany(db, before.company_id);
  });

  emitEvent('data:changed', { entity: 'contact', id });
  return readContact(db, id);
}

export function addContact(db: Db, companyId: string, patch: ContactPatch): ContactRow {
  const cid = canonicalCompanyId(db, companyId);
  const exists = get<{ id: string }>(db, 'SELECT id FROM company WHERE id = ?', cid);
  if (!exists) throw new Error(`Unknown company: ${companyId}`);

  const fullName = (patch.fullName ?? [patch.firstName, patch.lastName].filter(Boolean).join(' ')).trim();
  if (!fullName) throw new Error('A contact needs a name.');

  const id = ulid();
  tx(db, () => {
    run(
      db,
      `INSERT INTO contact (id, company_id, full_name, status, reviewed, created_at, updated_at)
       VALUES (?, ?, ?, 'candidate', 1, ?, ?)`,
      id,
      cid,
      fullName,
      Date.now(),
      Date.now(),
    );

    const columns = contactFieldColumns();
    observeContact(db, id, 'fullName', fullName, 'human', null, 'high');
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'fullName') continue;
      if (!(key in columns)) continue;
      observeContact(db, id, key, value as string | number | boolean | null, 'human', null, 'high');
    }
    if (patch.email) {
      run(db, `UPDATE contact SET email_source = 'human' WHERE id = ?`, id);
    }
    if (patch.status && CONTACT_STATUSES.has(patch.status)) {
      run(db, 'UPDATE contact SET status = ? WHERE id = ?', patch.status, id);
    }

    auditLog(db, { actor: 'operator', action: 'addContact', entity: 'contact', entityId: id, after: patch });
    electPrimaryContact(db, cid);
    recomputeCompany(db, cid);
  });

  emitEvent('data:changed', { entity: 'contact', id });
  return readContact(db, id);
}

export function deleteContact(db: Db, id: string): void {
  const row = get<{ company_id: string; full_name: string; email: string | null }>(
    db,
    'SELECT company_id, full_name, email FROM contact WHERE id = ?',
    id,
  );
  if (!row) return;

  const sent = get<{ n: number }>(db, 'SELECT count(*) AS n FROM send WHERE contact_id = ?', id);
  if ((sent?.n ?? 0) > 0) {
    // The send history is the audit trail for a message that actually left the
    // machine; deleting the contact would orphan it. Reject rather than cascade.
    throw new Error('This contact has been emailed. Mark them rejected or suppressed instead of deleting.');
  }

  tx(db, () => {
    run(db, 'DELETE FROM draft WHERE contact_id = ?', id);
    run(db, 'DELETE FROM contact WHERE id = ?', id);
    auditLog(db, { actor: 'operator', action: 'deleteContact', entity: 'contact', entityId: id, before: row });
    electPrimaryContact(db, row.company_id);
    recomputeCompany(db, row.company_id);
  });

  emitEvent('data:changed', { entity: 'contact', id });
}

export function readContact(db: Db, id: string): ContactRow {
  const row = get<ContactRowRaw>(db, `SELECT ${CONTACT_SELECT} FROM contact WHERE id = ?`, id);
  if (!row) throw new Error(`Unknown contact: ${id}`);
  return toContactRow(row);
}

export function listContacts(db: Db, companyId: string): ContactRow[] {
  return all<ContactRowRaw>(
    db,
    `SELECT ${CONTACT_SELECT} FROM contact WHERE company_id = ?
      ORDER BY is_primary DESC, contact_score DESC, created_at`,
    companyId,
  ).map(toContactRow);
}

// ─────────────────────────────────────────────────────────────────────────────

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in source) out[k] = source[k];
  return out;
}

function asText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerCompanyIpc(): void {
  handle('listCompanies', async (params: CompanyListParams) => listCompanies(getDb(), params));
  handle('getCompany', async (id: string) => getCompany(getDb(), id));
  handle('patchCompany', async (id: string, patch: CompanyPatch) => patchCompany(getDb(), id, patch));
  handle('bulkCompanyStatus', async (ids: string[], status: string) => bulkCompanyStatus(getDb(), ids, status));
  handle('resolveConflict', async (entityId: string, field: string, observationId: number) => {
    resolveConflict(getDb(), entityId, field, observationId);
  });

  handle('patchContact', async (id: string, patch: ContactPatch) => patchContact(getDb(), id, patch));
  handle('addContact', async (companyId: string, patch: ContactPatch) => addContact(getDb(), companyId, patch));
  handle('deleteContact', async (id: string) => {
    deleteContact(getDb(), id);
  });

  handle('findContacts', async (companyId: string) => {
    const db = getDb();
    const cid = canonicalCompanyId(db, companyId);
    await discoverContacts(db, cid, { generateCandidates: true });
    recomputeCompany(db, cid);
    emitEvent('data:changed', { entity: 'contact' });
    return listContacts(db, cid);
  });

  handle('verifyContact', async (id: string) => {
    const db = getDb();
    const row = get<{ company_id: string }>(db, 'SELECT company_id FROM contact WHERE id = ?', id);
    if (!row) throw new Error(`Unknown contact: ${id}`);
    await verifyContactById(db, id, { force: true });
    recomputeCompany(db, row.company_id);
    emitEvent('data:changed', { entity: 'contact', id });
    return readContact(db, id);
  });
}
