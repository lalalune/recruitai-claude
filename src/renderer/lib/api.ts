/**
 * Typed access to the main process, plus the TanStack Query layer.
 *
 * Two rules govern everything in this file:
 *
 * 1. The ranked company list is fetched exactly once and lives forever
 *    (`staleTime: Infinity`). 5,000 rows is ~5MB; refetching it on every
 *    approve would move 5MB every 24 seconds at the target review rate.
 * 2. Mutations therefore patch the cache in place. Nothing in the review hot
 *    path is allowed to call `invalidateQueries` on the list.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type {
  CompanyDetail,
  CompanyListParams,
  CompanyPatch,
  CompanyRow,
  ContactPatch,
  ContactRow,
  DashboardStats,
  EventName,
  LinkedInStatus,
  RecruitApi,
  RecruitEvents,
  SendStats,
} from '../../shared/ipc.js';
import { createEntityDebouncer, invalidationKeysFor } from './events.js';

/** The preload also exposes an event subscription helper alongside the API. */
export type EventBridge = {
  on<E extends EventName>(event: E, cb: (payload: RecruitEvents[E]) => void): () => void;
};

declare global {
  interface Window {
    api: RecruitApi & Partial<EventBridge>;
    events?: EventBridge;
  }
}

function bridge(): RecruitApi & Partial<EventBridge> {
  const w = window.api;
  if (!w) {
    throw new Error(
      'window.api is missing — the renderer was loaded outside Electron, or the preload script failed.',
    );
  }
  return w;
}

/**
 * Every call goes through here so a missing preload produces one clear error at
 * the call site instead of a cascade of "cannot read property of undefined".
 */
export const api: RecruitApi = new Proxy({} as RecruitApi, {
  get(_t, prop: string) {
    return (...args: unknown[]) => {
      const fn = (bridge() as unknown as Record<string, unknown>)[prop];
      if (typeof fn !== 'function') {
        return Promise.reject(new Error(`IPC method "${prop}" is not exposed by the preload.`));
      }
      return (fn as (...a: unknown[]) => unknown).apply(bridge(), args);
    };
  },
});

/**
 * Subscribe to a main→renderer event. Returns an unsubscribe function.
 *
 * The preload may expose the bridge as `window.api.on` or as a separate
 * `window.events`; both are accepted, and a missing bridge degrades to a no-op
 * rather than taking the screen down.
 */
export function subscribe<E extends EventName>(
  event: E,
  cb: (payload: RecruitEvents[E]) => void,
): () => void {
  const host = (typeof window.api?.on === 'function' ? window.api : window.events) as
    | EventBridge
    | undefined;
  if (!host || typeof host.on !== 'function') return () => {};
  const off = host.on(event, cb as (payload: RecruitEvents[EventName]) => void);
  return typeof off === 'function' ? off : () => {};
}

/**
 * The one place main→renderer events become query updates. Mounted once in App.
 *
 * - `data:changed` marks the affected queries stale, coalesced per entity so a
 *   pipeline burst becomes one refetch instead of hundreds (see lib/events.ts
 *   for the mapping and the hot-path rules it preserves).
 * - `send:progress` carries the fresh SendStats payload, so it is written into
 *   the cache directly — no refetch round-trip.
 * - `gmail:needs-reauth` surfaces a toast; sending is halted on the main side
 *   until the operator reconnects in Settings.
 */
export function useAppEventBridge(opts?: { onOpenSettings?: () => void }): void {
  const qc = useQueryClient();
  const onOpenSettings = opts?.onOpenSettings;
  useEffect(() => {
    const debouncer = createEntityDebouncer((entity, ids) => {
      for (const key of invalidationKeysFor(entity, ids)) {
        void qc.invalidateQueries({ queryKey: key as unknown as readonly unknown[] });
      }
    });
    const offs = [
      subscribe('data:changed', (p) => debouncer.push(p.entity, p.id)),
      subscribe('send:progress', (stats) => qc.setQueryData<SendStats>(qk.sendStats, stats)),
      subscribe('gmail:needs-reauth', ({ address }) => {
        void qc.invalidateQueries({ queryKey: qk.settings });
        toast.error('Gmail needs to be reconnected', {
          id: 'gmail-needs-reauth',
          duration: 10_000,
          description: `${address ?? 'Your account'} lost authorization — nothing will send. Reconnect in Settings.`,
          action: onOpenSettings ? { label: 'Open Settings', onClick: onOpenSettings } : undefined,
        });
      }),
    ];
    return () => {
      debouncer.dispose();
      for (const off of offs) off();
    };
  }, [qc, onOpenSettings]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Query keys
// ─────────────────────────────────────────────────────────────────────────────

export const qk = {
  companies: ['companies', 'list'] as const,
  company: (id: string) => ['company', id] as const,
  stats: ['stats'] as const,
  pipeline: ['pipeline'] as const,
  drafts: (state?: string) => ['drafts', state ?? 'all'] as const,
  sendStats: ['sendStats'] as const,
  inbound: (handled?: boolean) => ['inbound', handled ?? 'all'] as const,
  settings: ['settings'] as const,
  suppressions: ['suppressions'] as const,
  linkedin: ['linkedin', 'status'] as const,
  screenshot: (relPath: string) => ['screenshot', relPath] as const,
};

// The list is loaded whole; `limit` exists only to defeat any server-side default.
const LIST_PARAMS: CompanyListParams = { filter: 'all', sort: 'recent', limit: 1_000_000 };

// ─────────────────────────────────────────────────────────────────────────────
// Companies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole ranked list, once. Filtering and sorting happen in the renderer
 * because a keystroke must never wait on IPC. Rows arrive in discovery order,
 * which is what the "Recently discovered" sort reads.
 */
export function useCompanies() {
  return useQuery({
    queryKey: qk.companies,
    queryFn: () => api.listCompanies(LIST_PARAMS),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Trailing debounce. `value` settles `ms` after the last change. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Server-side search ids. The client filter stays instant (it never waits on
 * IPC); this AUGMENTS it with matches the rows can't see — contact
 * names/emails and req titles (FTS5) live only in the main process. Union of
 * both sets is what the operator perceives as "search everything", per
 * UX.md §5.2.
 *
 * The term is debounced because a new react-query key is NOT a debounce: every
 * keystroke would otherwise fire its own `listCompanies({search})` across IPC,
 * and a two-letter term matches most of a 5,000-row table — megabytes per
 * keypress, serialised through a synchronous SQLite main process.
 */
export function useServerSearchIds(search: string): Set<string> | null {
  const term = useDebounced(search.trim(), 220);
  const { data } = useQuery({
    queryKey: ['companies', 'search', term],
    queryFn: () => api.listCompanies({ search: term, limit: 1_000_000 }),
    enabled: term.length >= 2,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  return useMemo(() => (term.length >= 2 && data ? new Set(data.map((r) => r.id)) : null), [term, data]);
}

export function useCompany(id: string | null) {
  return useQuery({
    queryKey: qk.company(id ?? ''),
    queryFn: () => api.getCompany(id as string),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** Prefetches the record the operator is about to land on, so `j` never blanks. */
export function usePrefetchCompany() {
  const qc = useQueryClient();
  return (id: string | null | undefined) => {
    if (!id) return;
    void qc.prefetchQuery({
      queryKey: qk.company(id),
      queryFn: () => api.getCompany(id),
      staleTime: 60_000,
    });
  };
}

/** Project a fresh detail record back onto its row in the cached list. */
function mergeDetailIntoList(qc: QueryClient, detail: CompanyDetail): void {
  qc.setQueryData<CompanyRow[]>(qk.companies, (rows) =>
    rows?.map((r) =>
      r.id === detail.id
        ? {
            ...r,
            name: detail.name,
            domain: detail.domain,
            headcount: detail.headcount,
            industry: detail.industry,
            qualityScore: detail.qualityScore,
            scoreHeadline: detail.scoreHeadline,
            openReqCount: detail.openReqCount,
            openReqEngCount: detail.openReqEngCount,
            staleReqCount: detail.staleReqCount,
            maxDaysOpen: detail.maxDaysOpen,
            estimatedFeeUsd: detail.estimatedFeeUsd,
            hasInhouseTa: detail.hasInhouseTa,
            recruiterCount: detail.recruiterCount,
            contactCount: detail.contactCount,
            verifiedContactCount: detail.verifiedContactCount,
            hasConflict: detail.hasConflict,
            disqualified: detail.disqualified,
            status: detail.status,
            reviewed: detail.reviewed,
            ycBatch: detail.ycBatch,
            atsPlatform: detail.atsPlatform,
          }
        : r,
    ),
  );
}

/** The subset of a CompanyPatch that is visible on a list row. */
function rowPatch(patch: CompanyPatch): Partial<CompanyRow> {
  const out: Partial<CompanyRow> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.domain !== undefined) out.domain = patch.domain;
  if (patch.headcount !== undefined) out.headcount = patch.headcount;
  if (patch.industry !== undefined) out.industry = patch.industry;
  if (patch.recruiterCount !== undefined) out.recruiterCount = patch.recruiterCount;
  if (patch.hasInhouseTa !== undefined) out.hasInhouseTa = patch.hasInhouseTa;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.reviewed !== undefined) out.reviewed = patch.reviewed;
  return out;
}

export interface PatchCompanyVars {
  id: string;
  patch: CompanyPatch;
  /** Suppresses the failure toast when the caller renders its own. */
  quiet?: boolean;
}

/**
 * Keep the footer counters live during a review run without refetching the
 * 5,000-row list. At 150 records/hour an invalidate-per-keystroke would refetch
 * several MB every few seconds; the counters are derived from the same
 * transition we already know about, so patch them directly.
 */
function bumpStats(
  qc: QueryClient,
  prev: { reviewed: boolean; status: string } | undefined,
  next: { reviewed?: boolean; status?: string },
): void {
  if (!prev) return;
  qc.setQueryData<DashboardStats>(qk.stats, (s) => {
    if (!s) return s;
    let { reviewed, approved } = s;
    if (next.reviewed !== undefined && next.reviewed !== prev.reviewed) {
      reviewed += next.reviewed ? 1 : -1;
    }
    if (next.status !== undefined && next.status !== prev.status) {
      const wasApproved = prev.status === 'approved';
      const isApproved = next.status === 'approved';
      if (isApproved && !wasApproved) approved += 1;
      if (!isApproved && wasApproved) approved -= 1;
    }
    return { ...s, reviewed: Math.max(0, reviewed), approved: Math.max(0, approved) };
  });
}

export function usePatchCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: PatchCompanyVars) => api.patchCompany(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.company(id) });
      const prevList = qc.getQueryData<CompanyRow[]>(qk.companies);
      const prevDetail = qc.getQueryData<CompanyDetail | null>(qk.company(id));

      const rp = rowPatch(patch);
      const before = prevList?.find((r) => r.id === id);
      bumpStats(qc, before && { reviewed: before.reviewed, status: before.status }, patch);
      qc.setQueryData<CompanyRow[]>(qk.companies, (rows) =>
        rows?.map((r) => (r.id === id ? { ...r, ...rp } : r)),
      );
      qc.setQueryData<CompanyDetail | null>(qk.company(id), (d) =>
        d ? ({ ...d, ...patch } as CompanyDetail) : d,
      );
      return { prevList, prevDetail };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(qk.companies, ctx.prevList);
      if (ctx?.prevDetail !== undefined) qc.setQueryData(qk.company(vars.id), ctx.prevDetail);
      void qc.invalidateQueries({ queryKey: qk.stats });
      if (!vars.quiet) {
        toast.error('Could not save', { description: String((err as Error).message ?? err) });
      }
    },
    onSuccess: (detail) => {
      qc.setQueryData(qk.company(detail.id), detail);
      mergeDetailIntoList(qc, detail);
    },
  });
}

export function useBulkCompanyStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: string }) =>
      api.bulkCompanyStatus(ids, status),
    onMutate: async ({ ids, status }) => {
      const prevList = qc.getQueryData<CompanyRow[]>(qk.companies);
      const set = new Set(ids);
      const reviewed = status === 'approved' || status === 'rejected';
      qc.setQueryData<CompanyRow[]>(qk.companies, (rows) =>
        rows?.map((r) => (set.has(r.id) ? { ...r, status, reviewed: reviewed || r.reviewed } : r)),
      );
      for (const id of ids) qc.removeQueries({ queryKey: qk.company(id) });
      return { prevList };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(qk.companies, ctx.prevList);
      toast.error('Bulk update failed', { description: String((err as Error).message ?? err) });
    },
    // A bulk change can flip hundreds of rows at once, so deriving the counter
    // deltas row-by-row buys nothing. The stats query is a handful of COUNTs.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.stats });
    },
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      entityId,
      field,
      observationId,
    }: {
      entityId: string;
      field: string;
      observationId: number;
    }) => api.resolveConflict(entityId, field, observationId),
    onSuccess: async (_r, { entityId }) => {
      const fresh = await api.getCompany(entityId);
      if (fresh) {
        qc.setQueryData(qk.company(entityId), fresh);
        mergeDetailIntoList(qc, fresh);
      }
    },
    onError: (err) =>
      toast.error('Could not resolve conflict', {
        description: String((err as Error).message ?? err),
      }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts — all of these mutate a company detail, so they patch that cache
// ─────────────────────────────────────────────────────────────────────────────

function putContact(qc: QueryClient, companyId: string, contact: ContactRow): void {
  qc.setQueryData<CompanyDetail | null>(qk.company(companyId), (d) => {
    if (!d) return d;
    const exists = d.contacts.some((c) => c.id === contact.id);
    const contacts = exists
      ? d.contacts.map((c) =>
          c.id === contact.id
            ? contact
            : // Primary is exclusive; promoting one demotes the rest.
              contact.isPrimary
              ? { ...c, isPrimary: false }
              : c,
        )
      : [...d.contacts, contact];
    return { ...d, contacts, contactCount: contacts.length };
  });
}

export function usePatchContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; companyId: string; patch: ContactPatch }) =>
      api.patchContact(id, patch),
    onMutate: async ({ id, companyId, patch }) => {
      const prev = qc.getQueryData<CompanyDetail | null>(qk.company(companyId));
      qc.setQueryData<CompanyDetail | null>(qk.company(companyId), (d) =>
        d
          ? {
              ...d,
              contacts: d.contacts.map((c) =>
                c.id === id
                  ? ({ ...c, ...patch } as ContactRow)
                  : patch.isPrimary
                    ? { ...c, isPrimary: false }
                    : c,
              ),
            }
          : d,
      );
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(qk.company(vars.companyId), ctx.prev);
      toast.error('Could not save contact', {
        description: String((err as Error).message ?? err),
      });
    },
    onSuccess: (contact, { companyId }) => putContact(qc, companyId, contact),
  });
}

export function useAddContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, patch }: { companyId: string; patch: ContactPatch }) =>
      api.addContact(companyId, patch),
    onSuccess: (contact, { companyId }) => putContact(qc, companyId, contact),
    onError: (err) =>
      toast.error('Could not add contact', { description: String((err as Error).message ?? err) }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; companyId: string }) => api.deleteContact(id),
    onMutate: async ({ id, companyId }) => {
      const prev = qc.getQueryData<CompanyDetail | null>(qk.company(companyId));
      qc.setQueryData<CompanyDetail | null>(qk.company(companyId), (d) =>
        d
          ? {
              ...d,
              contacts: d.contacts.filter((c) => c.id !== id),
              contactCount: Math.max(0, d.contactCount - 1),
            }
          : d,
      );
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(qk.company(vars.companyId), ctx.prev);
      toast.error('Could not delete contact');
    },
  });
}

export function useFindContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (companyId: string) => api.findContacts(companyId),
    onSuccess: (contacts, companyId) => {
      qc.setQueryData<CompanyDetail | null>(qk.company(companyId), (d) =>
        d ? { ...d, contacts, contactCount: contacts.length } : d,
      );
      qc.setQueryData<CompanyRow[]>(qk.companies, (rows) =>
        rows?.map((r) =>
          r.id === companyId
            ? {
                ...r,
                contactCount: contacts.length,
                verifiedContactCount: contacts.filter((c) => c.emailVerdict === 'valid').length,
              }
            : r,
        ),
      );
      toast.success(
        contacts.length ? `Found ${contacts.length} contacts` : 'No new contacts found',
      );
    },
    onError: (err) =>
      toast.error('Contact discovery failed', {
        description: String((err as Error).message ?? err),
      }),
  });
}

export function useVerifyContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; companyId: string }) => api.verifyContact(id),
    onSuccess: (contact, { companyId }) => {
      putContact(qc, companyId, contact);
      qc.setQueryData<CompanyRow[]>(qk.companies, (rows) => {
        const detail = qc.getQueryData<CompanyDetail | null>(qk.company(companyId));
        if (!detail) return rows;
        const verified = detail.contacts.filter((c) => c.emailVerdict === 'valid').length;
        return rows?.map((r) => (r.id === companyId ? { ...r, verifiedContactCount: verified } : r));
      });
    },
    onError: (err) =>
      toast.error('Verification failed', { description: String((err as Error).message ?? err) }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Outreach, pipeline, settings — thin wrappers the other screens share
// ─────────────────────────────────────────────────────────────────────────────

export function useGenerateDraft() {
  const qc = useQueryClient();
  return useMutation({
    // `force` is the explicit Regenerate; a plain compose omits it so the
    // main-side guards (edited draft, already sent, mid-send, active
    // follow-up) can refuse with operator guidance.
    mutationFn: ({
      companyId,
      contactId,
      force,
    }: {
      companyId: string;
      contactId?: string;
      force?: boolean;
    }) => api.generateDraft(companyId, contactId, force),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drafts'] });
    },
    onError: (err) =>
      // Guard rejections are operator guidance (e.g. "use Follow up on the
      // Sent tab"), so the message is surfaced verbatim as the description.
      toast.error('Draft generation failed', {
        description: String((err as Error).message ?? err),
      }),
  });
}

export function useStats(options?: Partial<UseQueryOptions<DashboardStats>>) {
  return useQuery({
    queryKey: qk.stats,
    queryFn: () => api.getStats(),
    staleTime: 30_000,
    ...options,
  });
}

export function useSendStats() {
  return useQuery({
    queryKey: qk.sendStats,
    queryFn: () => api.getSendStats(),
    staleTime: 15_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When the stop expires. The main side halts for the remainder of the local day
 * rather than for a fixed duration, so this derives the release time from the
 * halt timestamp's next midnight.
 */
export function linkedInBlockedUntil(status: LinkedInStatus | undefined): number | null {
  if (!status) return null;
  if (typeof status.haltAt === 'number') {
    const midnight = new Date(status.haltAt);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
  }
  return null;
}

/**
 * Fast polling only while something is actually moving: the operator is in the
 * login window, a checkpoint is waiting, or the pipeline is spending budget.
 * Disabled, blocked and exhausted are settled states — nothing changes until
 * the operator or the calendar does.
 */
function linkedInInFlight(status: LinkedInStatus | undefined): boolean {
  return !status || status.needsOperator || status.state === 'ready';
}

export function useLinkedInStatus() {
  return useQuery<LinkedInStatus>({
    queryKey: qk.linkedin,
    queryFn: () => api.getLinkedInStatus(),
    refetchInterval: (query) => (linkedInInFlight(query.state.data) ? 5_000 : 30_000),
    staleTime: 2_000,
  });
}

/** The pipeline's LinkedIn steps become runnable or not, so it is invalidated too. */
function useLinkedInSession(run: () => Promise<LinkedInStatus>, failure: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (status) => {
      qc.setQueryData(qk.linkedin, status);
      void qc.invalidateQueries({ queryKey: qk.pipeline });
    },
    onError: (err) => toast.error(failure, { description: String((err as Error).message ?? err) }),
  });
}

export function useConnectLinkedIn() {
  return useLinkedInSession(() => api.connectLinkedIn(), 'LinkedIn sign-in failed');
}

export function useDisconnectLinkedIn() {
  return useLinkedInSession(() => api.disconnectLinkedIn(), 'Could not sign out of LinkedIn');
}

// ─────────────────────────────────────────────────────────────────────────────

/** Screenshots are read from disk on demand and returned as data URLs. */
export function useScreenshot(relPath: string | null) {
  return useQuery({
    queryKey: qk.screenshot(relPath ?? ''),
    queryFn: () => api.getScreenshot(relPath as string),
    enabled: !!relPath,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

export function openExternal(url: string): void {
  void api.openExternal(url).catch(() => toast.error('Could not open link'));
}
