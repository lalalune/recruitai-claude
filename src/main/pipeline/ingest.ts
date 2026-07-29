/**
 * Source output → database rows.
 *
 * Everything a source observes lands in `field_observation` with an evidence FK
 * to the gzipped raw response that produced it, then gets resolved into
 * `field_resolved` and mirrored onto the denormalised column the UI reads. That
 * means every value on screen can be traced to bytes we actually received, and
 * a human edit never destroys what a source said.
 */

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { all, get, run, tx, ulid, bulkLoadReqs, type Db } from '../db/index.js';
import { httpRequest, mapLimit, BlockedError } from '../util/http.js';
import {
  fetchYcCompanies,
  filterYcIcp,
  isBayArea,
  listWhoIsHiringThreads,
  fetchWhoIsHiringThread,
  resolveAtsFromCareersPage,
  candidateTokens,
  extractEmails,
  type YcCompany,
} from '../sources/seeds.js';
import { findCompanyLinkedIn } from '../sources/social.js';
import { probeAts, AllPlatformsBlockedError, ATS_FETCHERS } from '../sources/ats.js';
import { classifyNoAgency, classifyFunctionFamily, classifySeniority } from './scoring.js';
import { getIcp, getCrawl } from '../settings.js';
import { FEE_RATE } from '../../shared/score.js';
import type { AtsPlatform, AtsBoard, DiscoveredJob, SourceId, Confidence } from '../../shared/types.js';
import type { RunCtx, SourceOutcome } from './run.js';

// ─────────────────────────────────────────────────────────────────────────────
// Domain / naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Second-level public suffixes we actually encounter. A full Public Suffix List
 * is overkill for a Bay-Area startup database; getting `co.uk` and friends right
 * covers the real cases and a mis-split here only costs us one merge.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'co.jp', 'co.kr', 'com.br', 'com.mx', 'com.ar', 'co.in', 'co.za', 'com.sg',
  'com.hk', 'com.tw', 'com.tr', 'co.il', 'com.cn', 'co.id', 'com.ua', 'co.th',
]);

/**
 * Domains that are never a company identity. Keying on any of these silently
 * merges hundreds of unrelated companies into one row, and you find out months
 * later — this list is cheap insurance.
 */
const NON_COMPANY_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com',
  'hey.com', 'zoho.com', 'mail.com', 'gmx.com', 'yandex.com', 'qq.com', '163.com',
  'wixsite.com', 'webflow.io', 'myshopify.com', 'github.io', 'gitlab.io', 'notion.site',
  'squarespace.com', 'carrd.co', 'netlify.app', 'vercel.app', 'herokuapp.com', 'pages.dev',
  'substack.com', 'medium.com', 'linkedin.com', 'twitter.com', 'x.com', 'facebook.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com',
  'myworkdayjobs.com', 'breezy.hr', 'recruitee.com', 'teamtailor.com', 'rippling.com',
  'ycombinator.com', 'news.ycombinator.com', 'crunchbase.com', 'angel.co', 'wellfound.com',
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'sec.gov', 'google.com', 'docs.google.com',
]);

/** eTLD+1 from a URL, hostname, or email domain. Null for anything unusable. */
export function etldPlusOne(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;

  if (host.includes('@')) host = host.slice(host.lastIndexOf('@') + 1);
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split('/')[0] ?? '';
  host = host.split('?')[0] ?? '';
  host = host.split('#')[0] ?? '';
  host = host.split(':')[0] ?? '';
  host = host.replace(/\.+$/, '');
  if (!host || !host.includes('.') || /\s/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;

  const lastTwo = parts.slice(-2).join('.');
  const registrable =
    parts.length >= 3 && MULTI_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;

  if (NON_COMPANY_DOMAINS.has(registrable)) return null;
  if (registrable.length < 4) return null;
  return registrable;
}

const LEGAL_SUFFIX_RE =
  /[,.]?\s*\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|bv|sarl|pbc|plc|ag|oy|ab|as|pty|sa)\b\.?$/gi;

export function normName(name: string): string {
  let n = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  for (let i = 0; i < 3; i++) n = n.replace(LEGAL_SUFFIX_RE, '').trim();
  return n.replace(/[^a-z0-9]+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store a response body gzipped and deduped by the sha256 of the *uncompressed*
 * bytes. Re-fetching an unchanged board therefore costs one row update, not a
 * second copy of a 4 MB payload.
 */
export function storeRaw(
  db: Db,
  source: SourceId | string,
  url: string | null,
  statusCode: number | null,
  body: string | null,
): number | null {
  if (body == null) return null;
  const raw = Buffer.from(body, 'utf8');
  const sha = createHash('sha256').update(raw).digest('hex');
  const gz = gzipSync(raw, { level: 6 });

  const row = get<{ id: number }>(
    db,
    `INSERT INTO raw_response (sha256, source, url, status_code, encoding, body, bytes_raw, bytes_stored, fetched_at)
     VALUES (?, ?, ?, ?, 'gzip', ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET fetched_at = excluded.fetched_at, url = excluded.url
     RETURNING id`,
    sha,
    source,
    url,
    statusCode,
    gz,
    raw.length,
    gz.length,
    Date.now(),
  );
  return row?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance: observe → resolve → mirror
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much we trust a source's claim about a value. A human edit always wins;
 * a verifier outranks any scraper; a pattern inference is the weakest thing in
 * the system and must never beat something actually observed.
 */
export const SOURCE_TRUST: Record<string, number> = {
  human: 100,
  verifier: 90,
  hn_whoishiring: 78,
  greenhouse: 72,
  ashby: 72,
  lever: 72,
  smartrecruiters: 72,
  workable: 72,
  workday: 72,
  careers_page: 68,
  yc: 60,
  sec_formd: 55,
  linkedin: 50,
  dns: 45,
  pattern_inference: 20,
};

function trustOf(source: string): number {
  return SOURCE_TRUST[source] ?? 40;
}

type ColumnKind = 'text' | 'int' | 'bool';

const COMPANY_COLUMNS: Record<string, { col: string; kind: ColumnKind }> = {
  name: { col: 'name', kind: 'text' },
  domain: { col: 'domain', kind: 'text' },
  website: { col: 'website', kind: 'text' },
  headcount: { col: 'headcount', kind: 'int' },
  industry: { col: 'industry', kind: 'text' },
  hqLocation: { col: 'hq_location', kind: 'text' },
  inBayArea: { col: 'in_bay_area', kind: 'bool' },
  fundingStage: { col: 'funding_stage', kind: 'text' },
  lastRoundAt: { col: 'last_round_at', kind: 'int' },
  ycBatch: { col: 'yc_batch', kind: 'text' },
  atsPlatform: { col: 'ats_platform', kind: 'text' },
  atsToken: { col: 'ats_token', kind: 'text' },
  careersUrl: { col: 'careers_url', kind: 'text' },
  linkedinUrl: { col: 'linkedin_url', kind: 'text' },
  recruiterCount: { col: 'recruiter_count', kind: 'int' },
  hasInhouseTa: { col: 'has_inhouse_ta', kind: 'bool' },
};

const CONTACT_COLUMNS: Record<string, { col: string; kind: ColumnKind }> = {
  fullName: { col: 'full_name', kind: 'text' },
  firstName: { col: 'first_name', kind: 'text' },
  lastName: { col: 'last_name', kind: 'text' },
  title: { col: 'title', kind: 'text' },
  persona: { col: 'persona', kind: 'text' },
  seniority: { col: 'seniority', kind: 'text' },
  email: { col: 'email', kind: 'text' },
  phone: { col: 'phone', kind: 'text' },
  linkedinUrl: { col: 'linkedin_url', kind: 'text' },
};

export function companyFieldColumns(): Record<string, { col: string; kind: ColumnKind }> {
  return COMPANY_COLUMNS;
}
export function contactFieldColumns(): Record<string, { col: string; kind: ColumnKind }> {
  return CONTACT_COLUMNS;
}

export interface ResolvedWinner {
  obsId: number;
  value: string | null;
  source: string;
  confidence: Confidence;
  conflicting: boolean;
}

/**
 * Pick the winner for one (entity, id, field) and record whether sources disagree.
 *
 * Conflict is computed over the *latest observation per source*, not over all
 * history — a source updating its own value (YC bumping headcount 40 → 80) is
 * new information, not a conflict, and flagging it would drown the operator in
 * false amber.
 */
export function resolveEntityField(
  db: Db,
  entity: 'company' | 'contact' | 'req',
  entityId: string,
  field: string,
): ResolvedWinner | null {
  const rows = all<{ id: number; value: string | null; source: string; confidence: Confidence; observed_at: number }>(
    db,
    `SELECT id, value, source, confidence, observed_at
       FROM field_observation
      WHERE entity = ? AND entity_id = ? AND field = ?
      ORDER BY observed_at ASC, id ASC`,
    entity,
    entityId,
    field,
  );
  if (rows.length === 0) return null;

  const latestBySource = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latestBySource.set(r.source, r);

  let winner = rows[rows.length - 1]!;
  for (const candidate of latestBySource.values()) {
    const better =
      trustOf(candidate.source) > trustOf(winner.source) ||
      (trustOf(candidate.source) === trustOf(winner.source) && candidate.observed_at >= winner.observed_at);
    if (better) winner = candidate;
  }

  const distinct = new Set(
    [...latestBySource.values()].map((r) => normaliseForCompare(r.value)).filter((v) => v !== null),
  );
  // A human decision is the end of the argument, by construction.
  const conflicting = winner.source !== 'human' && distinct.size > 1;

  run(
    db,
    `INSERT INTO field_resolved (entity, entity_id, field, value, source, confidence, obs_id, conflicting, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity, entity_id, field) DO UPDATE SET
       value = excluded.value, source = excluded.source, confidence = excluded.confidence,
       obs_id = excluded.obs_id, conflicting = excluded.conflicting, resolved_at = excluded.resolved_at`,
    entity,
    entityId,
    field,
    winner.value,
    winner.source,
    winner.confidence,
    winner.id,
    conflicting ? 1 : 0,
    Date.now(),
  );

  return {
    obsId: winner.id,
    value: winner.value,
    source: winner.source,
    confidence: winner.confidence,
    conflicting,
  };
}

function normaliseForCompare(v: string | null): string | null {
  if (v == null) return null;
  const t = v.trim().toLowerCase();
  return t.length ? t : null;
}

function bindValue(value: string | null, kind: ColumnKind): string | number | null {
  if (value == null || value === '') return null;
  if (kind === 'int') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (kind === 'bool') return /^(1|true|yes|y)$/i.test(value.trim()) ? 1 : 0;
  return value;
}

/** Mirror the resolved winner onto the denormalised column the list query reads. */
export function applyCompanyColumn(db: Db, companyId: string, field: string, value: string | null): void {
  const spec = COMPANY_COLUMNS[field];
  if (!spec) return;
  const bound = bindValue(value, spec.kind);
  try {
    run(db, `UPDATE company SET ${spec.col} = ?, updated_at = ? WHERE id = ?`, bound, Date.now(), companyId);
  } catch (err) {
    // `domain` is UNIQUE; a collision means two records claim the same identity.
    // Keep the observation (it is evidence) and leave the column alone.
    if (spec.col !== 'domain') throw err;
    return;
  }
  if (field === 'name' && typeof bound === 'string') {
    run(db, 'UPDATE company SET name_norm = ? WHERE id = ?', normName(bound), companyId);
  }
}

export function applyContactColumn(db: Db, contactId: string, field: string, value: string | null): void {
  const spec = CONTACT_COLUMNS[field];
  if (!spec) return;
  const bound = bindValue(value, spec.kind);
  try {
    run(db, `UPDATE contact SET ${spec.col} = ?, updated_at = ? WHERE id = ?`, bound, Date.now(), contactId);
  } catch (err) {
    if (spec.col !== 'email') throw err;
    return;
  }
}

export function observeCompany(
  db: Db,
  companyId: string,
  field: string,
  value: string | number | boolean | null,
  source: SourceId | string,
  evidenceId: number | null,
  confidence: Confidence = 'medium',
): void {
  const text = toObservationText(value);
  writeObservation(db, 'company', companyId, field, text, source, evidenceId, confidence);
  const winner = resolveEntityField(db, 'company', companyId, field);
  if (winner) applyCompanyColumn(db, companyId, field, winner.value);
}

export function observeContact(
  db: Db,
  contactId: string,
  field: string,
  value: string | number | boolean | null,
  source: SourceId | string,
  evidenceId: number | null,
  confidence: Confidence = 'medium',
): void {
  const text = toObservationText(value);
  writeObservation(db, 'contact', contactId, field, text, source, evidenceId, confidence);
  const winner = resolveEntityField(db, 'contact', contactId, field);
  if (winner) applyContactColumn(db, contactId, field, winner.value);
}

export function writeObservation(
  db: Db,
  entity: 'company' | 'contact' | 'req',
  entityId: string,
  field: string,
  value: string | null,
  source: SourceId | string,
  evidenceId: number | null,
  confidence: Confidence,
): number {
  // A source repeating its own latest value adds no information — and the
  // daily board refresh would otherwise append identical (platform, token,
  // careersUrl) rows forever, with the resolver re-reading the whole history
  // on each one. Same-value re-observations return the existing row.
  const latest = get<{ id: number; value: string | null; confidence: Confidence }>(
    db,
    `SELECT id, value, confidence FROM field_observation
      WHERE entity = ? AND entity_id = ? AND field = ? AND source = ?
      ORDER BY observed_at DESC, id DESC LIMIT 1`,
    entity,
    entityId,
    field,
    source,
  );
  if (latest && latest.value === value && latest.confidence === confidence) return latest.id;

  const row = get<{ id: number }>(
    db,
    `INSERT INTO field_observation (entity, entity_id, field, value, source, evidence_id, confidence, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    entity,
    entityId,
    field,
    value,
    source,
    evidenceId,
    confidence,
    Date.now(),
  );
  return row?.id ?? 0;
}

function toObservationText(value: string | number | boolean | null): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value)) : null;
  const t = value.trim();
  return t.length ? t : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Companies
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanySeed {
  name: string;
  domain?: string | null;
  website?: string | null;
}

/** Resolve `canonical_id` chains so we never write to a merged-away row. */
export function canonicalCompanyId(db: Db, id: string): string {
  let current = id;
  for (let hop = 0; hop < 8; hop++) {
    const row = get<{ canonical_id: string | null }>(db, 'SELECT canonical_id FROM company WHERE id = ?', current);
    if (!row?.canonical_id) return current;
    current = row.canonical_id;
  }
  return current;
}

export function findCompany(db: Db, seed: CompanySeed): string | null {
  const domain = seed.domain ?? etldPlusOne(seed.website);
  if (domain) {
    const byDomain = get<{ id: string }>(db, 'SELECT id FROM company WHERE domain = ?', domain);
    if (byDomain) return canonicalCompanyId(db, byDomain.id);
  }
  const norm = normName(seed.name);
  if (norm.length >= 3) {
    const byName = get<{ id: string }>(
      db,
      'SELECT id FROM company WHERE name_norm = ? ORDER BY (domain IS NULL), created_at LIMIT 1',
      norm,
    );
    if (byName) return canonicalCompanyId(db, byName.id);
  }
  return null;
}

/** Insert-or-find keyed on eTLD+1, falling back to normalised name. */
export function upsertCompany(db: Db, seed: CompanySeed): string {
  const existing = findCompany(db, seed);
  if (existing) return existing;

  const id = ulid();
  const domain = seed.domain ?? etldPlusOne(seed.website);
  try {
    run(
      db,
      `INSERT INTO company (id, domain, name, name_norm, website, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      domain,
      seed.name.trim(),
      normName(seed.name),
      seed.website ?? null,
      Date.now(),
      Date.now(),
    );
    return id;
  } catch {
    // Lost a race on the UNIQUE(domain) index, or the domain is already taken by
    // a differently-named row. Fall back to whatever owns it.
    const again = findCompany(db, seed);
    if (again) return again;
    run(
      db,
      `INSERT INTO company (id, domain, name, name_norm, website, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      id,
      seed.name.trim(),
      normName(seed.name),
      seed.website ?? null,
      Date.now(),
      Date.now(),
    );
    return id;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Requisitions
// ─────────────────────────────────────────────────────────────────────────────

export interface ReqSyncResult {
  opened: number;
  updated: number;
  closed: number;
  reposted: number;
}

export function estimateFeeUsdFree(compMin: number | null, compMax: number | null): number | null {
  if (compMin == null && compMax == null) return null;
  const mid = compMin != null && compMax != null ? (compMin + compMax) / 2 : (compMin ?? compMax)!;
  if (!Number.isFinite(mid) || mid < 20_000 || mid > 2_000_000) return null;
  return Math.round(mid * FEE_RATE);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Diff a freshly-fetched board against what we already have.
 *
 * A req that vanishes is closed. A closed req that reappears increments
 * repost_count and restarts its clock — that pattern is a failed search, which
 * is the single strongest thing you can put in a cold email.
 */
export function upsertReqs(
  db: Db,
  companyId: string,
  source: SourceId | string,
  jobs: DiscoveredJob[],
  evidenceId: number | null,
  companyDomain: string | null,
): ReqSyncResult {
  const now = Date.now();
  const today = Math.floor(now / 86_400_000);
  const result: ReqSyncResult = { opened: 0, updated: 0, closed: 0, reposted: 0 };

  const existing = all<{ id: number; external_id: string; closed_at: number | null }>(
    db,
    'SELECT id, external_id, closed_at FROM req WHERE company_id = ? AND source = ?',
    companyId,
    source,
  );
  const byExternal = new Map(existing.map((r) => [r.external_id, r]));
  const seen = new Set<string>();

  for (const job of jobs) {
    const externalId = String(job.externalId ?? '').trim();
    if (!externalId || !job.title || !job.url) continue;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const description = job.descriptionText ?? null;
    const fee = estimateFeeUsdFree(job.compMin ?? null, job.compMax ?? null);
    const published = toEpochMs(job.publishedAt) ?? toEpochMs(job.updatedAt);
    const namedContact = extractNamedContact(description, companyDomain);
    const prior = byExternal.get(externalId);

    if (!prior) {
      const inserted = get<{ id: number }>(
        db,
        `INSERT INTO req (company_id, external_id, source, title, department, team, location, is_remote,
                          employment_type, comp_min, comp_max, estimated_fee_usd, description, url,
                          first_seen_at, last_seen_at, published_at, function_family, seniority,
                          no_agency_disclaimer, named_contact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        companyId,
        externalId,
        source,
        job.title.trim(),
        job.department ?? null,
        job.team ?? null,
        job.location ?? null,
        boolBit(job.isRemote),
        job.employmentType ?? null,
        intOrNull(job.compMin),
        intOrNull(job.compMax),
        fee,
        description,
        job.url,
        now,
        now,
        published,
        classifyFunctionFamily(job.title, job.department ?? null),
        classifySeniority(job.title),
        classifyNoAgency(description) ? 1 : 0,
        namedContact,
      );
      if (inserted) {
        result.opened++;
        markReqDay(db, inserted.id, today, 1);
      }
    } else {
      const reposted = prior.closed_at != null;
      run(
        db,
        `UPDATE req SET title = ?, department = ?, team = ?, location = ?, is_remote = ?, employment_type = ?,
                        comp_min = ?, comp_max = ?, estimated_fee_usd = ?, description = ?, url = ?,
                        last_seen_at = ?, closed_at = NULL,
                        published_at = COALESCE(?, published_at),
                        first_seen_at = CASE WHEN ? = 1 THEN ? ELSE first_seen_at END,
                        repost_count = repost_count + ?,
                        function_family = ?, seniority = ?, no_agency_disclaimer = ?,
                        named_contact = COALESCE(?, named_contact)
          WHERE id = ?`,
        job.title.trim(),
        job.department ?? null,
        job.team ?? null,
        job.location ?? null,
        boolBit(job.isRemote),
        job.employmentType ?? null,
        intOrNull(job.compMin),
        intOrNull(job.compMax),
        fee,
        description,
        job.url,
        now,
        published,
        reposted ? 1 : 0,
        now,
        reposted ? 1 : 0,
        classifyFunctionFamily(job.title, job.department ?? null),
        classifySeniority(job.title),
        classifyNoAgency(description) ? 1 : 0,
        namedContact,
        prior.id,
      );
      if (reposted) result.reposted++;
      else result.updated++;
      markReqDay(db, prior.id, today, 1);
    }

    if (namedContact && companyDomain) {
      upsertContactFromEmail(db, companyId, namedContact, source, evidenceId, 'Named in job description');
    }
  }

  for (const prior of existing) {
    if (seen.has(prior.external_id) || prior.closed_at != null) continue;
    run(db, 'UPDATE req SET closed_at = ? WHERE id = ?', now, prior.id);
    markReqDay(db, prior.id, today, 0);
    result.closed++;
  }

  recomputeDaysOpen(db, companyId, source, now);
  return result;
}

function markReqDay(db: Db, reqId: number, day: number, present: 0 | 1): void {
  run(
    db,
    `INSERT INTO req_daily (req_id, day, present) VALUES (?, ?, ?)
     ON CONFLICT(req_id, day) DO UPDATE SET present = excluded.present`,
    reqId,
    day,
    present,
  );
}

function recomputeDaysOpen(db: Db, companyId: string, source: SourceId | string, now: number): void {
  run(
    db,
    `UPDATE req
        SET days_open = MAX(0, CAST((COALESCE(closed_at, ?) - COALESCE(published_at, first_seen_at)) / 86400000 AS INTEGER))
      WHERE company_id = ? AND source = ?`,
    now,
    companyId,
    source,
  );
}

/**
 * A JD that prints an address at the hiring company's own domain is the hiring
 * party publishing a contact for exactly this purpose. Anything at another
 * domain (an ATS relay, a privacy alias) is ignored.
 */
function extractNamedContact(description: string | null, companyDomain: string | null): string | null {
  if (!description || !companyDomain) return null;
  const matches = description.match(EMAIL_RE);
  if (!matches) return null;
  for (const raw of matches) {
    const email = raw.toLowerCase().replace(/[.,;:)\]]+$/, '');
    if (etldPlusOne(email) === companyDomain) return email;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts observed from sources
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_LOCAL_PARTS = new Set([
  'jobs', 'careers', 'hiring', 'recruiting', 'recruitment', 'talent', 'hr', 'people',
  'info', 'hello', 'hey', 'contact', 'team', 'support', 'admin', 'sales', 'press',
  'apply', 'work', 'join', 'help', 'office', 'general',
]);

/**
 * Create a contact from an address a source published verbatim.
 *
 * The address is copied byte-for-byte from the source — nothing here constructs,
 * completes, or guesses an address. Role addresses are marked `role` up front so
 * they sort below a real decision maker without spending a verification credit.
 */
export function upsertContactFromEmail(
  db: Db,
  companyId: string,
  email: string,
  source: SourceId | string,
  evidenceId: number | null,
  note: string,
): string | null {
  const clean = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) return null;

  const existing = get<{ id: string; company_id: string }>(db, 'SELECT id, company_id FROM contact WHERE email = ?', clean);
  if (existing) return existing.company_id === companyId ? existing.id : null;

  const local = clean.slice(0, clean.indexOf('@'));
  const isRole = ROLE_LOCAL_PARTS.has(local.replace(/[^a-z]/g, ''));
  const id = ulid();

  try {
    run(
      db,
      `INSERT INTO contact (id, company_id, full_name, email, email_source, email_verdict, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      companyId,
      humaniseLocalPart(local),
      clean,
      source,
      isRole ? 'role' : 'unverified',
      note,
      Date.now(),
      Date.now(),
    );
  } catch {
    return null;
  }

  writeObservation(db, 'contact', id, 'email', clean, source, evidenceId, 'high');
  resolveEntityField(db, 'contact', id, 'email');
  writeObservation(db, 'contact', id, 'fullName', humaniseLocalPart(local), source, evidenceId, 'low');
  resolveEntityField(db, 'contact', id, 'fullName');
  return id;
}

function humaniseLocalPart(local: string): string {
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || local;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: Y Combinator directory
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestYc(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const icp = getIcp();
  ctx.log('info', 'Fetching the YC company directory (single request, ~10 MB)…');

  const res = await fetchYcCompanies();
  if (!res.ok || !res.data) {
    throw new Error(res.error ?? `YC directory fetch failed (HTTP ${res.httpStatus ?? 0})`);
  }

  const evidenceId = storeRaw(db, 'yc', res.url, res.httpStatus ?? 200, JSON.stringify(res.data));
  const filtered = filterYcIcp(res.data, {
    minTeam: icp.minHeadcount,
    maxTeam: icp.maxHeadcount,
    requireHiring: false,
  });

  ctx.log('info', `${res.data.length} YC companies, ${filtered.length} in the Bay Area ICP band.`);
  ctx.progress(0, filtered.length);

  let done = 0;
  const CHUNK = 100;
  for (let i = 0; i < filtered.length; i += CHUNK) {
    if (ctx.cancelled()) break;
    const chunk = filtered.slice(i, i + CHUNK);
    tx(db, () => {
      for (const yc of chunk) ingestOneYcCompany(db, yc, evidenceId);
    });
    done += chunk.length;
    ctx.progress(done, filtered.length);
  }

  return { records: done, message: `${done} Bay Area YC companies upserted` };
}

function ingestOneYcCompany(db: Db, yc: YcCompany, evidenceId: number | null): void {
  const domain = etldPlusOne(yc.website);
  const companyId = upsertCompany(db, { name: yc.name, domain, website: yc.website });

  observeCompany(db, companyId, 'name', yc.name, 'yc', evidenceId, 'high');
  if (domain) observeCompany(db, companyId, 'domain', domain, 'yc', evidenceId, 'high');
  if (yc.website) observeCompany(db, companyId, 'website', yc.website, 'yc', evidenceId, 'high');
  if (yc.batch) observeCompany(db, companyId, 'ycBatch', yc.batch, 'yc', evidenceId, 'high');
  if (yc.all_locations) {
    observeCompany(db, companyId, 'hqLocation', yc.all_locations, 'yc', evidenceId, 'medium');
    observeCompany(db, companyId, 'inBayArea', isBayArea(yc.all_locations), 'yc', evidenceId, 'high');
  }
  // team_size is self-reported and updated irregularly — real, but not gospel.
  if (yc.team_size != null) observeCompany(db, companyId, 'headcount', yc.team_size, 'yc', evidenceId, 'medium');

  const industry = yc.industry ?? yc.industries?.[0] ?? yc.subindustry ?? null;
  if (industry) observeCompany(db, companyId, 'industry', industry, 'yc', evidenceId, 'medium');
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: ATS token sweep
// ─────────────────────────────────────────────────────────────────────────────

interface SweepTarget {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
}

interface SweepHit {
  target: SweepTarget;
  board: AtsBoard;
}

function isBlockSignal(err: unknown): boolean {
  if (err instanceof BlockedError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|403)\b/.test(message) || /halted|blocked by host/i.test(message);
}

/** Boards buffered before a write. Small enough to bound loss, large enough that
 *  the transaction overhead stays negligible. */
const SWEEP_FLUSH_EVERY = 25;

/** A company whose board we already know how to reach — refresh, don't probe. */
interface RefreshTarget extends SweepTarget {
  ats_platform: string;
  ats_token: string;
}

export async function ingestAtsSweep(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const crawl = getCrawl();
  const targets = all<SweepTarget>(
    db,
    `SELECT id, name, website, domain FROM company
      WHERE ats_token IS NULL AND canonical_id IS NULL
      ORDER BY (headcount IS NULL), quality_score DESC, created_at`,
  );

  // Snapshot the refresh set BEFORE probing: a board resolved by this very run
  // was fetched moments ago and re-fetching it now would say nothing new.
  const refreshTargets = all<RefreshTarget>(
    db,
    `SELECT id, name, website, domain, ats_platform, ats_token FROM company
      WHERE ats_platform IS NOT NULL AND ats_token IS NOT NULL AND canonical_id IS NULL
      ORDER BY (headcount IS NULL), quality_score DESC, created_at`,
  );

  if (targets.length === 0 && refreshTargets.length === 0) {
    return { records: 0, message: 'No companies to probe and no known boards to refresh' };
  }

  // Per-platform, not global: one host rate-limiting us must not throw away the
  // whole sweep. probeAts adds to this set and skips those platforms thereafter.
  const blockedPlatforms = new Set<AtsPlatform>();
  let allBlocked = false;
  const pending: SweepHit[] = [];
  let resolved = 0;
  let totalJobs = 0;
  let closed = 0;
  let reposted = 0;

  // Persist as we go rather than buffering the whole sweep. A 5,000-company run
  // takes tens of minutes against live hosts; writing only at the end would
  // throw all of it away on any mid-run failure, and the sweep is designed to be
  // resumable (targets are selected by `ats_token IS NULL`).
  const flush = () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const jobs = batch.reduce((n, h) => n + h.board.jobs.length, 0);
    const write = () =>
      tx(db, () => {
        for (const hit of batch) {
          const sync = persistBoard(db, hit.target, hit.board);
          closed += sync.closed;
          reposted += sync.reposted;
        }
      });
    // FTS triggers dominate large inserts; drop and rebuild past a couple thousand.
    if (jobs > 2000) bulkLoadReqs(db, write);
    else write();
    resolved += batch.length;
    totalJobs += jobs;
  };

  if (targets.length > 0) {
    ctx.log('info', `Probing ${targets.length} companies against ${Object.keys(ATS_FETCHERS).length} ATS platforms…`);
    ctx.progress(0, targets.length);

    await mapLimit(
      targets,
      crawl.concurrency,
      async (target) => {
        if (allBlocked || ctx.cancelled()) return null;
        for (const token of candidateTokens(target.name, target.website)) {
          if (allBlocked || ctx.cancelled()) return null;
          try {
            const board = await probeAts(token, blockedPlatforms, { name: target.name, domain: target.domain });
            if (board) {
              pending.push({ target, board });
              if (pending.length >= SWEEP_FLUSH_EVERY) flush();
              return null;
            }
          } catch (err) {
            // Only raised once EVERY platform has blocked us; then there is
            // nothing left to ask and we stand down.
            if (err instanceof AllPlatformsBlockedError || isBlockSignal(err)) {
              allBlocked = true;
              return null;
            }
          }
        }
        return null;
      },
      { jitterMs: 150, onProgress: (done, total) => ctx.progress(done, total) },
    );

    flush();
  }

  const discovered = resolved;
  ctx.log('info', `${discovered} boards resolved, ${totalJobs} open roles ingested.`);
  if (allBlocked) {
    logBlockedPlatforms(ctx, blockedPlatforms);
    // The counts ride in the message: the flush above already persisted this
    // work, and a bare "blocked" in lastResult would hide that it landed.
    throw new BlockedError(`ats-sweep (persisted ${discovered} boards, ${totalJobs} roles before standing down)`, 429);
  }

  // Refresh pass: re-fetch every board we already know the address of, so the
  // req differ can see closes, reposts and staling. Without this, a company is
  // fetched exactly once in its life and open_req_count fossilises — the
  // close/repost machinery in upsertReqs never gets a second look.
  if (refreshTargets.length > 0 && !ctx.cancelled()) {
    ctx.log('info', `Refreshing ${refreshTargets.length} known boards for closes and reposts…`);
    ctx.progress(0, refreshTargets.length);

    await mapLimit(
      refreshTargets,
      crawl.concurrency,
      async (target) => {
        if (allBlocked || ctx.cancelled()) return null;
        const fetcher = ATS_FETCHERS[target.ats_platform as keyof typeof ATS_FETCHERS];
        // Careers pages record platforms we have no adapter for (workday,
        // rippling, …) — nothing to re-fetch there.
        if (!fetcher) return null;
        const platform = target.ats_platform as AtsPlatform;
        if (blockedPlatforms.has(platform)) return null;
        try {
          const result = await fetcher(target.ats_token);
          if (result.httpStatus === 429 || result.httpStatus === 403) blockedPlatforms.add(platform);
          // An empty board is a real observation — every role closed. A failed
          // fetch is not: only ok results reach the differ, so a 404 or outage
          // can never mass-close a company's reqs. A PARTIAL board (pagination
          // broke mid-way) is worse than a failed one here: the differ would
          // read the missing pages as hundreds of closes, then re-open them as
          // fake "reposts" — which end up as false claims in outreach copy.
          if (result.ok && result.data && !result.data.partial) {
            if (Number(get<{ n: number }>(db, 'SELECT ats_miss_count AS n FROM company WHERE id = ?', target.id)?.n ?? 0) !== 0) {
              run(db, 'UPDATE company SET ats_miss_count = 0 WHERE id = ?', target.id);
            }
            pending.push({ target, board: result.data });
            if (pending.length >= SWEEP_FLUSH_EVERY) flush();
          } else if (result.httpStatus === 404) {
            // One 404 is an outage; three consecutive are a dead board. Then
            // absence is finally trustworthy: close via the normal differ and
            // drop the token so the careers-crawl can re-resolve it later.
            const misses = Number(get<{ n: number }>(db, 'SELECT ats_miss_count AS n FROM company WHERE id = ?', target.id)?.n ?? 0) + 1;
            if (misses >= 3) {
              tx(db, () => {
                upsertReqs(db, target.id, platform, [], null, target.domain);
                run(db, 'UPDATE company SET ats_token = NULL, ats_miss_count = 0, updated_at = ? WHERE id = ?', Date.now(), target.id);
              });
              ctx.log('warn', `Board for ${target.name ?? target.id} gone (3 consecutive 404s) — reqs closed, token cleared.`);
            } else {
              run(db, 'UPDATE company SET ats_miss_count = ? WHERE id = ?', misses, target.id);
            }
          }
        } catch (err) {
          if (isBlockSignal(err)) blockedPlatforms.add(platform);
        }
        return null;
      },
      { jitterMs: 150, onProgress: (done, total) => ctx.progress(done, total) },
    );

    flush();
  }

  const refreshed = resolved - discovered;
  logBlockedPlatforms(ctx, blockedPlatforms);
  ctx.log('info', `${refreshed} known boards refreshed (${closed} closed, ${reposted} reposted).`);
  return {
    records: resolved,
    message: `${discovered} ATS boards discovered, ${refreshed} refreshed (${closed} closed, ${reposted} reposted), ${totalJobs} roles`,
  };
}

function logBlockedPlatforms(ctx: RunCtx, blockedPlatforms: Set<AtsPlatform>): void {
  if (blockedPlatforms.size === 0) return;
  ctx.log(
    'warn',
    `Rate-limited by ${[...blockedPlatforms].join(', ')} — those platforms were skipped for the rest of this run. Re-run later to pick them up.`,
  );
}

function persistBoard(db: Db, target: SweepTarget, board: AtsBoard): ReqSyncResult {
  const evidenceId = storeRaw(db, board.platform, boardUrl(board), 200, board.rawBody);
  observeCompany(db, target.id, 'atsPlatform', board.platform, board.platform, evidenceId, 'high');
  observeCompany(db, target.id, 'atsToken', board.token, board.platform, evidenceId, 'high');
  const careers = board.jobs[0]?.url ?? null;
  if (careers) observeCompany(db, target.id, 'careersUrl', careers, board.platform, evidenceId, 'medium');
  return upsertReqs(db, target.id, board.platform, board.jobs, evidenceId, target.domain);
}

function boardUrl(board: AtsBoard): string {
  switch (board.platform) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs?content=true`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${board.token}`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${board.token}?mode=json`;
    case 'smartrecruiters':
      return `https://api.smartrecruiters.com/v1/companies/${board.token}/postings`;
    case 'workable':
      return `https://apply.workable.com/api/v1/widget/accounts/${board.token}`;
    default:
      return board.token;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: company LinkedIn URL discovery
//
// The LinkedIn enrichment source is keyed on company.linkedin_url and nothing
// else produces one, so without this step that whole feature has no targets.
// Slugs are frequently not derivable from the domain (sift.com -> getsift), so
// this reads the company's own site rather than guessing.
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestLinkedInUrls(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const crawl = getCrawl();
  const targets = all<{ id: string; name: string; website: string }>(
    db,
    `SELECT id, name, website FROM company
      WHERE canonical_id IS NULL
        AND (linkedin_url IS NULL OR linkedin_url = '')
        AND website IS NOT NULL AND website != ''
      ORDER BY quality_score DESC NULLS LAST, open_req_count DESC`,
  );

  if (targets.length === 0) return { records: 0, message: 'Every company already has a LinkedIn URL' };

  ctx.log('info', `Reading ${targets.length} company sites for their LinkedIn page…`);
  ctx.progress(0, targets.length);

  const found: { id: string; url: string; foundAt: string; pageBody: string }[] = [];
  let flushed = 0;

  const flush = () => {
    if (found.length === 0) return;
    const batch = found.splice(0, found.length);
    tx(db, () => {
      for (const f of batch) {
        // Evidence is the PAGE we read, not the URL string we derived from it —
        // "every value traces to bytes we actually received".
        const evidenceId = storeRaw(db, 'careers_page', f.foundAt, 200, f.pageBody);
        observeCompany(db, f.id, 'linkedinUrl', f.url, 'careers_page', evidenceId, 'high');
      }
    });
    flushed += batch.length;
  };

  await mapLimit(
    targets,
    Math.max(2, Math.floor(crawl.concurrency / 2)),
    async (target) => {
      if (ctx.cancelled()) return null;
      const profile = await findCompanyLinkedIn(target.website);
      if (profile) {
        found.push({ id: target.id, url: profile.linkedinUrl, foundAt: profile.foundAt, pageBody: profile.pageBody });
        if (found.length >= 25) flush();
      }
      return null;
    },
    { jitterMs: 150, onProgress: (done, total) => ctx.progress(done, total) },
  );

  flush();
  ctx.log('info', `${flushed} LinkedIn company URLs resolved.`);
  return { records: flushed, message: `${flushed} LinkedIn URLs from ${targets.length} sites` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: careers-page crawl (recovers boards whose token isn't guessable)
// ─────────────────────────────────────────────────────────────────────────────

interface CrawlHit {
  target: SweepTarget;
  platform: string;
  token: string;
  foundAt: string;
  board: AtsBoard | null;
  rawBody: string | null;
}

export async function ingestCareersCrawl(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const crawl = getCrawl();
  const targets = all<SweepTarget>(
    db,
    `SELECT id, name, website, domain FROM company
      WHERE ats_token IS NULL AND canonical_id IS NULL AND website IS NOT NULL AND website != ''
      ORDER BY created_at`,
  );

  if (targets.length === 0) return { records: 0, message: 'Nothing left to crawl' };

  ctx.log('info', `Reading ${targets.length} careers pages for embedded ATS links…`);
  ctx.progress(0, targets.length);

  // Per-platform, exactly like the sweep: the careers pages and each ATS host
  // are different parties, and one board host rate-limiting us must not end
  // the crawl for everyone else. A global stop here once threw away a whole
  // run on a single 429 — see VERIFIED-SOURCES.md.
  const blockedPlatforms = new Set<AtsPlatform>();
  let resolved = 0;
  let roles = 0;

  const pending: CrawlHit[] = [];

  // Persist as we go rather than buffering the whole crawl — same rationale as
  // the sweep's flush: a long run must not lose everything to one mid-run
  // failure, and a resolved token is durable the moment it is written.
  const flush = () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const jobs = batch.reduce((n, h) => n + (h.board?.jobs.length ?? 0), 0);
    const write = () =>
      tx(db, () => {
        for (const f of batch) {
          const evidenceId = storeRaw(db, 'careers_page', f.foundAt, 200, f.rawBody ?? f.foundAt);
          observeCompany(db, f.target.id, 'atsPlatform', f.platform, 'careers_page', evidenceId, 'high');
          observeCompany(db, f.target.id, 'atsToken', f.token, 'careers_page', evidenceId, 'high');
          observeCompany(db, f.target.id, 'careersUrl', f.foundAt, 'careers_page', evidenceId, 'high');
          resolved++;
          if (f.board) {
            const r = upsertReqs(db, f.target.id, f.board.platform, f.board.jobs, evidenceId, f.target.domain);
            roles += r.opened + r.updated + r.reposted;
          }
        }
      });
    // FTS triggers dominate large inserts; drop and rebuild past a couple thousand.
    if (jobs > 2000) bulkLoadReqs(db, write);
    else write();
  };

  const push = (hit: CrawlHit) => {
    pending.push(hit);
    if (pending.length >= SWEEP_FLUSH_EVERY) flush();
  };

  await mapLimit(
    targets,
    Math.max(2, Math.floor(crawl.concurrency / 2)),
    async (target) => {
      if (ctx.cancelled() || !target.website) return null;
      let probe;
      try {
        probe = await resolveAtsFromCareersPage(target.website);
      } catch {
        // The company's own site failing (or blocking us) says nothing about
        // any other target or any ATS host — skip this one and keep crawling.
        return null;
      }
      if (!probe) return null;

      const fetcher = ATS_FETCHERS[probe.platform as keyof typeof ATS_FETCHERS];
      const platform = probe.platform as AtsPlatform;
      if (!fetcher || blockedPlatforms.has(platform)) {
        // No adapter (workday, rippling, …) or the platform told us to stop:
        // still record the resolved platform+token — the sweep's refresh pass
        // fetches the board once the host is willing again.
        push({ target, platform: probe.platform, token: probe.token, foundAt: probe.foundAt, board: null, rawBody: null });
        return null;
      }
      try {
        const result = await fetcher(probe.token);
        // A 429/403 blocks that one platform for the rest of the crawl, never
        // the others. SmartRecruiters can 429 on page 2+ with page 1 in hand;
        // that partial board is real data and is kept.
        if (result.httpStatus === 429 || result.httpStatus === 403) blockedPlatforms.add(platform);
        push({
          target,
          platform: probe.platform,
          token: probe.token,
          foundAt: probe.foundAt,
          board: result.ok ? result.data : null,
          rawBody: result.rawBody ?? null,
        });
      } catch (err) {
        if (isBlockSignal(err)) blockedPlatforms.add(platform);
      }
      return null;
    },
    { jitterMs: 250, onProgress: (done, total) => ctx.progress(done, total) },
  );

  flush();

  if (blockedPlatforms.size > 0) {
    ctx.log(
      'warn',
      `Rate-limited by ${[...blockedPlatforms].join(', ')} — those platforms were skipped for the rest of this crawl.`,
    );
  }
  return { records: resolved, message: `${resolved} boards recovered from careers pages, ${roles} roles` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: HN "Ask HN: Who is hiring?"
//
// The cleanest provenance in the pipeline: the hiring party published the
// address itself, in a thread whose entire purpose is being contacted about it.
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestHn(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const threads = await listWhoIsHiringThreads(12);
  if (threads.length === 0) return { records: 0, message: 'No Who-Is-Hiring threads returned' };

  ctx.log('info', `Reading ${threads.length} monthly threads…`);
  ctx.progress(0, threads.length);

  let contacts = 0;
  let matched = 0;
  let index = 0;

  for (const thread of threads) {
    if (ctx.cancelled()) break;
    const postings = await fetchWhoIsHiringThread(thread.objectID);
    const evidenceId = storeRaw(
      db,
      'hn_whoishiring',
      `https://hn.algolia.com/api/v1/items/${thread.objectID}`,
      200,
      JSON.stringify(postings),
    );

    tx(db, () => {
      for (const posting of postings) {
        if (posting.emails.length === 0) continue;

        const domains = new Set<string>();
        for (const url of posting.urls) {
          const d = etldPlusOne(url);
          if (d) domains.add(d);
        }
        if (domains.size === 0) continue;

        for (const domain of domains) {
          const company = get<{ id: string }>(db, 'SELECT id FROM company WHERE domain = ?', domain);
          if (!company) continue;
          const companyId = canonicalCompanyId(db, company.id);
          matched++;

          for (const email of posting.emails) {
            // Only accept an address at the company's own domain. A personal
            // Gmail in the same post is not evidence about this company.
            if (etldPlusOne(email) !== domain) continue;
            const contactId = upsertContactFromEmail(
              db,
              companyId,
              email,
              'hn_whoishiring',
              evidenceId,
              `Published in ${posting.threadTitle} by ${posting.author}`,
            );
            if (contactId) contacts++;
          }
        }
      }
    });

    ctx.progress(++index, threads.length);
  }

  return { records: contacts, message: `${contacts} self-published contacts across ${matched} matched postings` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: SEC EDGAR Form D
//
// Form D results skew hard to investment funds rather than operating companies,
// so this deliberately only *enriches companies we already know about* with a
// funding date. Creating rows from it would fill the database with LP vehicles.
// ─────────────────────────────────────────────────────────────────────────────

interface EftsHit {
  _id: string;
  _source: { file_date?: string; display_names?: string[]; ciks?: string[] };
}

const FUND_MARKERS =
  /\b(fund|partners|capital|ventures?|lp|l\.p|管理|holdings|trust|advisors?|management|opportunit|spv|series [a-z] fund)\b/i;

const FORM_D_QUERIES = ['"San Francisco"', '"Palo Alto"', '"Mountain View"', '"Menlo Park"', '"Oakland"', '"San Mateo"'];

export async function ingestSecFormD(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86_400_000);
  const startdt = start.toISOString().slice(0, 10);
  const enddt = end.toISOString().slice(0, 10);

  let enriched = 0;
  let scanned = 0;
  ctx.progress(0, FORM_D_QUERIES.length * 10);

  for (const [qi, query] of FORM_D_QUERIES.entries()) {
    for (let page = 0; page < 10; page++) {
      if (ctx.cancelled()) break;
      const url =
        `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}` +
        `&forms=D&startdt=${startdt}&enddt=${enddt}&from=${page * 10}`;

      const res = await httpRequest(url, { timeoutMs: 30_000, maxRetries: 1 });
      if (res.blocked) {
        ctx.log('warn', 'EDGAR asked us to stop; ending the Form D pass here.');
        return { records: enriched, message: `${enriched} funding signals before EDGAR backed us off` };
      }
      if (!res.ok || !res.body) break;

      let hits: EftsHit[] = [];
      try {
        const parsed = JSON.parse(res.body) as { hits?: { hits?: EftsHit[] } };
        hits = parsed.hits?.hits ?? [];
      } catch {
        break;
      }
      if (hits.length === 0) break;

      const evidenceId = storeRaw(db, 'sec_formd', url, res.status, res.body);

      tx(db, () => {
        for (const hit of hits) {
          scanned++;
          const display = hit._source.display_names?.[0];
          if (!display) continue;
          const name = display.replace(/\s*\(CIK\s*[^)]*\)\s*$/i, '').trim();
          if (!name || FUND_MARKERS.test(name)) continue;

          const norm = normName(name);
          if (norm.length < 3) continue;
          const company = get<{ id: string }>(db, 'SELECT id FROM company WHERE name_norm = ? LIMIT 1', norm);
          if (!company) continue;

          const companyId = canonicalCompanyId(db, company.id);
          const filedAt = toEpochMs(hit._source.file_date ?? null);
          if (filedAt == null) continue;

          observeCompany(db, companyId, 'lastRoundAt', filedAt, 'sec_formd', evidenceId, 'high');
          observeCompany(db, companyId, 'fundingStage', 'Form D filing', 'sec_formd', evidenceId, 'low');
          enriched++;
        }
      });

      ctx.progress(qi * 10 + page + 1, FORM_D_QUERIES.length * 10);
      if (hits.length < 10) break;
    }
  }

  return { records: enriched, message: `${enriched} funding signals from ${scanned} Form D filings` };
}

// ─────────────────────────────────────────────────────────────────────────────

export function toEpochMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function boolBit(v: boolean | null | undefined): number | null {
  if (v == null) return null;
  return v ? 1 : 0;
}

function intOrNull(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v);
}

export { EMAIL_RE, extractEmails };
