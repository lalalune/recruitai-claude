/**
 * Pure logic for the main→renderer event bridge: which react-query keys a
 * `data:changed` payload invalidates, and the per-entity debouncer that
 * coalesces event bursts. Kept free of React/query imports so unit tests can
 * exercise it under plain node.
 */

export type QueryKeyish = readonly string[];

/**
 * Map a `data:changed` payload onto the query keys that must be revalidated.
 *
 * `ids` is the coalesced set of record ids seen during the debounce window;
 * `null` means at least one event arrived without an id (bulk/pipeline writes).
 *
 * Company events that carry ids are the renderer's own single-record mutations
 * (patchCompany, resolveConflict) — those handlers already merged the
 * authoritative response into both the list and detail caches, so only the
 * detail is revalidated. Id-less company events are pipeline/bulk writes the
 * renderer has never seen: those refetch the list and the server-search id
 * sets (prefix ['companies','search'] — react-query refetches only the ACTIVE
 * search queries). This keeps the review hot path free of full-list refetches
 * (see the rules at the top of lib/api.ts) while still making pipeline output
 * appear without a restart.
 */
export function invalidationKeysFor(entity: string, ids: readonly string[] | null = null): QueryKeyish[] {
  switch (entity) {
    case 'company':
      return ids
        ? [...ids.map((id) => ['company', id] as const), ['stats'] as const]
        : [['companies', 'list'], ['companies', 'search'], ['company'], ['stats'], ['suppressions']];
    case 'contact':
      // Contacts render inside company details and roll up into list columns
      // (contactCount / verifiedContactCount / qualityScore), so the list is
      // refreshed for targeted writes too — contact edits are operator-
      // frequency, not hot-path. The event id is the contact id, which no
      // query key contains, so the detail prefix covers both shapes.
      return [['companies', 'list'], ['company'], ['stats']];
    case 'draft':
      // A draft event fires on every send, so ['sent'] and ['performance']
      // ride it — otherwise the Sent tab lags its 60s poll behind reality.
      return [['drafts'], ['stats'], ['sendStats'], ['sent'], ['performance']];
    case 'inbound':
      // markInbound flips send outcomes (replied/bounced) — same two rides.
      return [['inbound'], ['stats'], ['sent'], ['performance']];
    case 'suppression':
      return [['suppressions'], ['companies', 'list'], ['company'], ['stats']];
    default:
      // Unknown entity: someone added a new emitter on the main side. Refetch
      // everything the UI derives from the database rather than silently
      // showing stale data.
      return [
        ['companies', 'list'],
        ['company'],
        ['drafts'],
        ['inbound'],
        ['suppressions'],
        ['stats'],
        ['sendStats'],
      ];
  }
}

export interface EntityDebouncer {
  /** Record one event. The flush fires `wait` ms after the last push. */
  push(entity: string, id?: string): void;
  /** Fire every pending flush immediately (teardown, tests). */
  flushAll(): void;
  /** Drop pending work without flushing. */
  dispose(): void;
}

interface Pending {
  timer: ReturnType<typeof setTimeout> | null;
  /** Epoch ms after which the flush fires even if events keep arriving. */
  deadline: number;
  ids: Set<string>;
  sawBroad: boolean;
}

/**
 * Trailing debounce per entity with a max wait: the pipeline emits
 * `data:changed` continuously while a sweep runs, and a pure trailing debounce
 * would starve until the sweep pauses. `maxWait` guarantees the UI refreshes
 * periodically even under a steady stream.
 */
export function createEntityDebouncer(
  flush: (entity: string, ids: string[] | null) => void,
  wait = 500,
  maxWait = 2500,
): EntityDebouncer {
  const pending = new Map<string, Pending>();

  const fire = (entity: string): void => {
    const p = pending.get(entity);
    if (!p) return;
    pending.delete(entity);
    if (p.timer) clearTimeout(p.timer);
    flush(entity, p.sawBroad ? null : [...p.ids]);
  };

  return {
    push(entity, id) {
      const now = Date.now();
      let p = pending.get(entity);
      if (!p) {
        p = { timer: null, deadline: now + maxWait, ids: new Set(), sawBroad: false };
        pending.set(entity, p);
      }
      if (id == null) p.sawBroad = true;
      else p.ids.add(id);
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => fire(entity), Math.max(0, Math.min(wait, p.deadline - now)));
    },
    flushAll() {
      const entities = Array.from(pending.keys()); // fire() mutates pending
      for (const entity of entities) fire(entity);
    },
    dispose() {
      for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
      pending.clear();
    },
  };
}
