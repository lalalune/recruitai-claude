/**
 * Background task drainer.
 *
 * The pipeline's sources run as direct async jobs the operator triggers, which
 * is right for a sweep. But one piece of work must happen *reactively*: when a
 * company is approved in Review, its first draft should be waiting by the time
 * the operator reaches the Outreach screen. Blocking the approve keystroke on
 * draft generation would wreck the review loop, and firing an un-awaited promise
 * would lose the work on quit.
 *
 * So approve enqueues a durable task and this drains it. Draft generation may
 * call an LLM, so it can fail, and the queue's attempt/backoff/dead-letter
 * handling is exactly what that needs.
 */

import { getDb } from '../db/index.js';
import { claim, complete, fail, requeueStale } from './tasks.js';
import { generateDraftFor } from './drafts.js';
import { emitEvent, appendLog } from './run.js';

export const TASK_GENERATE_DRAFT = 'generate_draft';

/** Polling beats a notify mechanism here: one indexed query every few seconds. */
const TICK_MS = 3_000;

let timer: NodeJS.Timeout | null = null;
let draining = false;

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  [TASK_GENERATE_DRAFT]: async (payload) => {
    const companyId = String(payload.companyId ?? '');
    if (!companyId) throw new Error('generate_draft task has no companyId');
    const db = getDb();
    const draft = await generateDraftFor(db, companyId);
    if (draft) emitEvent('data:changed', { entity: 'draft', id: draft.id });
  },
};

/**
 * Drains until the queue is empty, one task at a time.
 *
 * Serial on purpose: these tasks write to SQLite and may call a paid API, and
 * there is no throughput problem to solve — the operator approves at human speed.
 */
async function drainOnce(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const db = getDb();
    for (;;) {
      const task = claim(db);
      if (!task) break;

      const handler = HANDLERS[task.kind];
      if (!handler) {
        // Unknown kind is a bug, not a transient failure. Retrying forever would
        // hide it, so bury it immediately and say so.
        fail(db, task.id, new Error(`No handler registered for task kind "${task.kind}"`));
        appendLog('pipeline', 'error', `Unknown task kind "${task.kind}" — buried.`);
        continue;
      }

      try {
        await handler(JSON.parse(task.payload) as Record<string, unknown>);
        complete(db, task.id);
      } catch (err) {
        const outcome = fail(db, task.id, err);
        const message = err instanceof Error ? err.message : String(err);
        appendLog(
          'pipeline',
          outcome === 'dead' ? 'error' : 'warn',
          outcome === 'dead'
            ? `Task ${task.kind} failed permanently: ${message}`
            : `Task ${task.kind} failed, will retry: ${message}`,
        );
      }
    }
  } catch (err) {
    // The drainer must never take the app down.
    console.error('[drain] tick failed:', err);
  } finally {
    draining = false;
  }
}

export function startDrainer(): void {
  if (timer) return;
  // A task left 'running' by a crash would otherwise never be picked up again.
  try {
    const requeued = requeueStale(getDb());
    if (requeued > 0) appendLog('pipeline', 'warn', `Requeued ${requeued} task(s) interrupted by a previous exit.`);
  } catch {
    /* the database may not be ready yet; the first tick will cover it */
  }
  timer = setInterval(() => void drainOnce(), TICK_MS);
  timer.unref?.();
}

export function stopDrainer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed so a test can drive the queue deterministically instead of waiting. */
export const __drainOnceForTests = drainOnce;
