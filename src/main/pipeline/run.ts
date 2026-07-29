/**
 * The source registry and the run loop.
 *
 * One runner per SourceKey, a single in-flight run at a time, cooperative
 * cancellation, and progress pushed to the renderer as it happens. Everything
 * that spends money is gated behind the scoring pass — `enrich_*` work is only
 * ever created for entities that already scored, never by a discovery job.
 */

import type { BrowserWindow } from 'electron';
import { getDb, all, get, type Db } from '../db/index.js';
import { BlockedError } from '../util/http.js';
import { getSetting, setSetting, getCrawl, getSpendCapUsd, hasSecret, SECRET_VERIFIER, SECRET_ANTHROPIC } from '../settings.js';
import { spendByProvider, requeueStale, SpendCapExceeded } from './tasks.js';
import { SpendCapError } from '../verify/verifier.js';
import { ingestYc, ingestAtsSweep, ingestCareersCrawl, ingestHn, ingestSecFormD } from './ingest.js';
import { scoreAll, recomputeCompany } from './scoring.js';
import { generateAllDrafts } from './drafts.js';
import * as linkedin from '../linkedin/index.js';
import { ingestLinkedInUrls } from './ingest.js';
import { discoverContacts, verifyCompanyContacts, upsertContact, estimatePendingVerifications } from './contacts.js';
import { observeCompany } from './ingest.js';
import type { EventName, LogLine, PipelineState, RecruitEvents, SourceKey, SourceStatus } from '../../shared/ipc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Run context
// ─────────────────────────────────────────────────────────────────────────────

export interface RunCtx {
  key: SourceKey;
  log(level: LogLine['level'], message: string): void;
  progress(done: number, total: number): void;
  cancelled(): boolean;
}

export interface SourceOutcome {
  records: number;
  message: string;
}

type Runner = (db: Db, ctx: RunCtx) => Promise<SourceOutcome>;

// ─────────────────────────────────────────────────────────────────────────────
// Renderer transport
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

export function setPipelineWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function emitEvent<K extends EventName>(channel: K, payload: RecruitEvents[K]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {
    // The window went away between the check and the send; nothing to do.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost estimation for the paid steps
// ─────────────────────────────────────────────────────────────────────────────

/** Mid-market verifier pricing; the ledger records what was actually charged. */
const VERIFY_USD_PER_EMAIL = 0.008;
/** Opus-5 rewrite at ~600 in / ~350 out tokens. */
const DRAFT_USD_PER_EMAIL = 0.012;

/**
 * Enrichment only ever touches entities that already made it past scoring. This
 * is the hard rule that keeps the discovery loop free forever: no paid task can
 * be created by a discovery job, only by something downstream of the gate.
 */
function gate(alias: string): string {
  const a = alias ? `${alias}.` : '';
  return `${a}disqualified IS NULL AND ${a}quality_score IS NOT NULL AND ${a}quality_score >= 6
          AND ${a}status IN ('scored','approved') AND ${a}canonical_id IS NULL`;
}

const ENRICHMENT_GATE = gate('');
const ENRICHMENT_GATE_CO = gate('co');


// ─────────────────────────────────────────────────────────────────────────────
// Enrichment runners (gated, per-company)
// ─────────────────────────────────────────────────────────────────────────────

async function runContactDiscovery(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const targets = all<{ id: string }>(
    db,
    `SELECT id FROM company
      WHERE ${ENRICHMENT_GATE}
        AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.company_id = company.id AND c.email IS NOT NULL)
      ORDER BY quality_score DESC, estimated_fee_usd DESC`,
  );

  ctx.log('info', `${targets.length} scored companies still have no reachable contact.`);
  ctx.progress(0, targets.length);

  let found = 0;
  for (const [i, t] of targets.entries()) {
    if (ctx.cancelled()) break;
    try {
      await discoverContacts(db, t.id, { generateCandidates: true });
      recomputeCompany(db, t.id);
      found++;
    } catch (err) {
      if (err instanceof SpendCapExceeded || err instanceof BlockedError) {
        ctx.log('warn', `${err.message} — stopping contact discovery.`);
        break;
      }
      ctx.log('warn', `Contact discovery failed for ${t.id}: ${messageOf(err)}`);
    }
    ctx.progress(i + 1, targets.length);
  }
  return { records: found, message: `${found} companies enriched with contacts` };
}

async function runEmailVerify(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const targets = all<{ id: string }>(
    db,
    `SELECT DISTINCT co.id FROM company co
       JOIN contact c ON c.company_id = co.id
      WHERE ${ENRICHMENT_GATE_CO}
        AND c.email IS NOT NULL AND c.email_verdict = 'unverified'
      ORDER BY co.quality_score DESC`,
  );

  ctx.log('info', `Verifying addresses at ${targets.length} companies.`);
  ctx.progress(0, targets.length);

  let done = 0;
  for (const [i, t] of targets.entries()) {
    if (ctx.cancelled()) break;
    try {
      const report = await verifyCompanyContacts(db, t.id, { tryCandidates: true });
      recomputeCompany(db, t.id);
      if (report.blocked) {
        // Rule 3 in verifier.ts: a 429/403 stops the RUN, not just the company —
        // continuing would knock on a provider that already said no. The
        // blocked company is not counted: it was cut off mid-way.
        ctx.log('warn', 'Verification provider returned 429/403 — stopping the run.');
        break;
      }
      done++;
    } catch (err) {
      // Two spend-stop classes exist: the ledger's (tasks.ts) and the
      // verifier's own (verifier.ts). Either one means stop, not skip.
      if (err instanceof SpendCapExceeded || err instanceof SpendCapError) {
        ctx.log('warn', `${err.message} — stopping verification.`);
        break;
      }
      ctx.log('warn', `Verification failed for ${t.id}: ${messageOf(err)}`);
    }
    ctx.progress(i + 1, targets.length);
  }
  return { records: done, message: `${done} companies verified` };
}

async function runLinkedin(db: Db, ctx: RunCtx): Promise<SourceOutcome> {
  const crawl = getCrawl();
  if (!crawl.linkedinEnabled) {
    return { records: 0, message: 'LinkedIn is disabled in Settings (off by default, deliberately)' };
  }
  // The session layer enforces the real per-day request budget; size this
  // run's target list from what is LEFT today, not the full daily number —
  // otherwise each run of the source selects a fresh full-budget batch.
  const status = await linkedin.getStatus();
  if (!(await linkedin.isAvailable())) {
    // Say WHY: "sign in first" on a budget-exhausted or day-halted session
    // sends the operator to fix the wrong thing.
    const why =
      status.state === 'budget_exhausted'
        ? `daily request budget used (${status.budgetUsed}/${status.budgetPerDay}) — resumes tomorrow`
        : status.haltReason
          ? `halted for the day (${status.haltReason})`
          : status.message || 'sign in from Settings first';
    return { records: 0, message: `LinkedIn unavailable — ${why}` };
  }

  const remaining = Math.max(0, status.budgetRemaining);
  // Each company costs roughly two requests (recruiter count + people search).
  const budget = Math.floor(remaining / 2);
  if (budget === 0) {
    return {
      records: 0,
      message: `Only ${remaining} LinkedIn request${remaining === 1 ? '' : 's'} left today — a company needs two. Try tomorrow.`,
    };
  }
  // The LinkedIn adapter is keyed on the company's LinkedIn URL, so a company
  // without one simply isn't reachable by this source.
  const targets = all<{ id: string; linkedin_url: string }>(
    db,
    `SELECT id, linkedin_url FROM company
      WHERE ${ENRICHMENT_GATE} AND recruiter_count IS NULL AND linkedin_url IS NOT NULL AND linkedin_url != ''
      ORDER BY quality_score DESC LIMIT ?`,
    budget,
  );

  ctx.log('info', `Checking in-house recruiter headcount for ${targets.length} companies (${remaining} requests left today).`);
  ctx.progress(0, targets.length);

  let done = 0;
  for (const [i, t] of targets.entries()) {
    if (ctx.cancelled()) break;
    if (!(await linkedin.isAvailable())) {
      ctx.log('warn', 'LinkedIn session is no longer available — stopping.');
      break;
    }

    try {
      const signal = await linkedin.countRecruiters(t.linkedin_url);
      if (signal) {
        // `truncated` means we hit the page cap, so the count is a lower bound —
        // record it, but never let a lower bound assert "no in-house TA".
        observeCompany(db, t.id, 'recruiterCount', signal.recruiterCount, 'linkedin', null, signal.truncated ? 'low' : 'medium');
        if (!signal.truncated || signal.hasInhouseTa) {
          observeCompany(db, t.id, 'hasInhouseTa', signal.hasInhouseTa, 'linkedin', null, 'medium');
        }
        if (signal.headcount != null) {
          observeCompany(db, t.id, 'headcount', signal.headcount, 'linkedin', null, 'medium');
        }
        if (signal.industry) observeCompany(db, t.id, 'industry', signal.industry, 'linkedin', null, 'low');
      }

      const people = await linkedin.findDecisionMakers(t.linkedin_url);
      for (const person of people ?? []) {
        // Identification only. LinkedIn never supplies an address here, and
        // upsertContact is given none — addresses come from other sources.
        upsertContact(db, t.id, {
          fullName: person.fullName,
          title: person.title ?? person.headline ?? null,
          linkedinUrl: person.publicProfileUrl ?? null,
          source: 'linkedin',
          confidence: 'medium',
        });
      }

      recomputeCompany(db, t.id);
      done++;
    } catch (err) {
      // A CAPTCHA or a block is a stop signal, never something to work around.
      ctx.log('warn', `LinkedIn stopped at ${t.id}: ${messageOf(err)}`);
      break;
    }
    ctx.progress(i + 1, targets.length);
  }
  return { records: done, message: `${done} companies checked for in-house TA` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

interface SourceDef {
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresKey: string | null;
  estimateCostUsd(db: Db): number | null;
  run: Runner;
}

const SOURCES: Record<SourceKey, SourceDef> = {
  yc: {
    label: 'YC directory',
    description: 'One request for all 6,000+ YC companies; filters to the Bay Area ICP band.',
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: ingestYc,
  },
  ats_sweep: {
    label: 'ATS sweep',
    description: 'Probes Ashby, Greenhouse, Lever, Workable and SmartRecruiters for each company’s public board.',
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: ingestAtsSweep,
  },
  careers_crawl: {
    label: 'Careers-page crawler',
    description: 'Reads careers pages for embedded ATS links, recovering boards whose token isn’t guessable.',
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: ingestCareersCrawl,
  },
  linkedin_urls: {
    label: 'LinkedIn URL discovery',
    description:
      "Reads each company's own site for the LinkedIn page it links to. Required before LinkedIn enrichment can run — the slugs are usually not derivable from the domain.",
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: ingestLinkedInUrls,
  },
  hn_whoishiring: {
    label: 'HN Who Is Hiring',
    description: 'Twelve months of threads; captures addresses the hiring party published itself.',
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: ingestHn,
  },
  sec_formd: {
    label: 'SEC Form D',
    description: 'Recent Bay Area Form D filings; adds a funding date to companies we already track.',
    defaultEnabled: false,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: ingestSecFormD,
  },
  linkedin: {
    label: 'LinkedIn (manual session)',
    description: 'Counts in-house recruiters. Off by default — opens a real browser window you control.',
    defaultEnabled: false,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: runLinkedin,
  },
  contact_discovery: {
    label: 'Contact discovery',
    description: 'Finds decision makers at companies that scored well but have no reachable address.',
    defaultEnabled: true,
    requiresKey: null,
    // Free by design: discoverContacts touches nothing beyond DNS. Inventing a
    // per-company dollar figure here made a $0 step look like a paid one.
    estimateCostUsd: () => null,
    run: runContactDiscovery,
  },
  email_verify: {
    label: 'Email verification',
    description: 'Paid verifier pass. 93% of these domains sit behind Google, where SMTP probing tells you nothing.',
    defaultEnabled: true,
    requiresKey: 'verifier',
    estimateCostUsd: (db) => {
      // The freshness-aware estimator: counts stale re-verifications and
      // pattern candidates too, matching what a run would actually spend.
      const n = estimatePendingVerifications(db, 183);
      return n === 0 ? null : Math.round(n * VERIFY_USD_PER_EMAIL * 100) / 100;
    },
    run: runEmailVerify,
  },
  scoring: {
    label: 'Scoring',
    description: 'Recomputes derived signals and the 1–10 quality score for every company.',
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: () => null,
    run: scoreAll,
  },
  draft_generation: {
    label: 'Draft generation',
    description: 'Writes a tailored draft per approved company. Uses the Anthropic key if one is set.',
    defaultEnabled: true,
    requiresKey: null,
    estimateCostUsd: (db) => {
      const row = get<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM company co
          WHERE co.status = 'approved' AND co.disqualified IS NULL
            AND NOT EXISTS (SELECT 1 FROM draft d JOIN contact c ON c.id = d.contact_id
                             WHERE c.company_id = co.id AND d.state != 'skipped')`,
      );
      const n = row?.n ?? 0;
      return n === 0 ? null : Math.round(n * DRAFT_USD_PER_EMAIL * 100) / 100;
    },
    run: generateAllDrafts,
  },
};

export const SOURCE_ORDER: SourceKey[] = [
  'yc',
  'ats_sweep',
  'careers_crawl',
  'linkedin_urls',
  'hn_whoishiring',
  'sec_formd',
  'linkedin',
  'scoring',
  'contact_discovery',
  'email_verify',
  'draft_generation',
];

// ─────────────────────────────────────────────────────────────────────────────
// Live state
// ─────────────────────────────────────────────────────────────────────────────

interface LiveState {
  running: boolean;
  progress: { done: number; total: number } | null;
}

const live = new Map<SourceKey, LiveState>();
const logBuffer: LogLine[] = [];
const LOG_LIMIT = 200;

let anyRunning = false;
let stopRequested = false;
let lastEmit = 0;

function liveOf(key: SourceKey): LiveState {
  let s = live.get(key);
  if (!s) {
    s = { running: false, progress: null };
    live.set(key, s);
  }
  return s;
}

export function isSourceEnabled(key: SourceKey): boolean {
  return getSetting(`pipeline.${key}.enabled`, SOURCES[key].defaultEnabled) === true;
}

export function setSourceEnabled(key: SourceKey, enabled: boolean): void {
  if (!(key in SOURCES)) return;
  setSetting(`pipeline.${key}.enabled`, enabled === true);
  emitProgress(true);
}

export function appendLog(source: string, level: LogLine['level'], message: string): void {
  const line: LogLine = { at: Date.now(), level, source, message };
  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  emitEvent('pipeline:log', line);
}

export function getPipelineState(): PipelineState {
  const db = getDb();
  const sources: SourceStatus[] = SOURCE_ORDER.map((key) => {
    const def = SOURCES[key];
    const state = liveOf(key);
    return {
      key,
      label: def.label,
      description: def.description,
      enabled: isSourceEnabled(key),
      running: state.running,
      lastRunAt: getSetting<number | null>(`pipeline.${key}.lastRunAt`, null),
      lastResult: getSetting<string | null>(`pipeline.${key}.lastResult`, null),
      recordsFound: getSetting<number>(`pipeline.${key}.records`, 0),
      progress: state.progress,
      estimatedCostUsd: safeEstimate(def, db),
      requiresKey: def.requiresKey,
    };
  });

  const spend = spendByProvider(db);
  const capUsd = getSpendCapUsd();
  if (spend.length === 0) spend.push({ provider: 'all', spentUsd: 0, capUsd });

  return { sources, running: anyRunning, log: [...logBuffer], spend };
}

function safeEstimate(def: SourceDef, db: Db): number | null {
  try {
    return def.estimateCostUsd(db);
  } catch {
    return null;
  }
}

function emitProgress(force = false): void {
  const now = Date.now();
  // The full state includes a handful of COUNT queries; 250 ms is smooth in the
  // UI without turning a long sweep into a database benchmark.
  if (!force && now - lastEmit < 250) return;
  lastEmit = now;
  emitEvent('pipeline:progress', getPipelineState());
}

// ─────────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────────

export function stopPipeline(): void {
  if (!anyRunning) return;
  stopRequested = true;
  appendLog('pipeline', 'warn', 'Stop requested — finishing the current step and standing down.');
  emitProgress(true);
}

function makeCtx(key: SourceKey): RunCtx {
  const state = liveOf(key);
  return {
    key,
    log: (level, message) => appendLog(key, level, message),
    progress: (done, total) => {
      state.progress = total > 0 ? { done, total } : null;
      emitProgress();
    },
    cancelled: () => stopRequested,
  };
}

/** Run one source. Serialised: a second call while a run is in flight is a no-op. */
export async function runSource(key: SourceKey): Promise<void> {
  if (!(key in SOURCES)) throw new Error(`Unknown source: ${key}`);
  if (anyRunning) {
    appendLog(key, 'warn', 'Another source is already running.');
    return;
  }

  // Claim BEFORE any await — the key-availability check below suspends, and a
  // second Run click landing in that gap would start a concurrent run.
  anyRunning = true;
  const def = SOURCES[key];
  if (def.requiresKey === 'verifier' && !(await verifierKeyAvailable())) {
    anyRunning = false;
    appendLog(key, 'error', 'No verifier API key configured — add one in Settings.');
    emitProgress(true);
    return;
  }

  stopRequested = false;
  await runOne(key, def);
  anyRunning = false;
  emitProgress(true);
}

/**
 * A verifier key can live in Settings (secret store) or in the environment —
 * loadVerifierConfig honours RECRUITAI_VERIFIER_KEY, so gating on the secret
 * store alone refused to run for env-configured setups.
 */
async function verifierKeyAvailable(): Promise<boolean> {
  if (process.env.RECRUITAI_VERIFIER_KEY) return true;
  return hasSecret(SECRET_VERIFIER);
}

/** Run every enabled source in dependency order (discovery → score → enrich → draft). */
export async function runAll(): Promise<void> {
  if (anyRunning) {
    appendLog('pipeline', 'warn', 'A run is already in flight.');
    return;
  }

  anyRunning = true;
  stopRequested = false;
  appendLog('pipeline', 'info', 'Starting full pipeline run.');

  for (const key of SOURCE_ORDER) {
    if (stopRequested) break;
    if (!isSourceEnabled(key)) continue;

    const def = SOURCES[key];
    if (def.requiresKey === 'verifier' && !(await verifierKeyAvailable())) {
      appendLog(key, 'warn', 'Skipped: no verifier API key configured.');
      continue;
    }
    if (key === 'draft_generation' && !(await hasSecret(SECRET_ANTHROPIC))) {
      appendLog(key, 'info', 'No Anthropic key set — drafts will use the deterministic templates.');
    }
    await runOne(key, def);
  }

  anyRunning = false;
  appendLog('pipeline', 'info', stopRequested ? 'Run stopped.' : 'Run complete.');
  emitProgress(true);
}

async function runOne(key: SourceKey, def: SourceDef): Promise<void> {
  const db = getDb();
  const state = liveOf(key);
  state.running = true;
  state.progress = null;
  const startedAt = Date.now();
  appendLog(key, 'info', `${def.label}: starting.`);
  emitProgress(true);

  try {
    const outcome = await def.run(db, makeCtx(key));
    setSetting(`pipeline.${key}.lastRunAt`, Date.now());
    setSetting(`pipeline.${key}.lastResult`, outcome.message);
    setSetting(`pipeline.${key}.records`, outcome.records);
    appendLog(key, 'info', `${def.label}: ${outcome.message} (${Math.round((Date.now() - startedAt) / 1000)}s).`);
  } catch (err) {
    const message =
      err instanceof BlockedError
        ? `${err.message} This source is now stopped. We do not retry or rotate around a block.`
        : messageOf(err);
    setSetting(`pipeline.${key}.lastRunAt`, Date.now());
    setSetting(`pipeline.${key}.lastResult`, `Failed: ${message}`);
    appendLog(key, 'error', `${def.label}: ${message}`);
  } finally {
    state.running = false;
    state.progress = null;
    emitProgress(true);
    emitEvent('data:changed', { entity: 'company' });
  }
}

/** Called once at startup: nothing may be left claimed by a process that died. */
export function recoverAfterRestart(): void {
  const requeued = requeueStale(getDb());
  if (requeued > 0) appendLog('pipeline', 'info', `Requeued ${requeued} tasks left running by a previous session.`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
