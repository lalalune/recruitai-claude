import {
  Building2,
  Check,
  ChevronDown,
  ExternalLink,
  Inbox,
  Plus,
  RefreshCw,
  Search,
  Send,
  Star,
  Trash2,
  TriangleAlert,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'sonner';

import type {
  CompanyDetail,
  CompanyPatch,
  CompanyRow,
  ContactPatch,
  ContactRow,
  ReqRow,
  ResolvedField,
} from '../../shared/ipc.js';
import type { Persona } from '../../shared/types.js';
import {
  api,
  openExternal,
  useAddContact,
  useBulkCompanyStatus,
  useCompanies,
  useServerSearchIds,
  useCompany,
  useDeleteContact,
  useFindContacts,
  useGenerateDraft,
  usePatchCompany,
  usePatchContact,
  usePrefetchCompany,
  useResolveConflict,
  useVerifyContact,
} from '../lib/api.js';
import {
  ago,
  compBand,
  dateShort,
  hostOf,
  num,
  personaLabel,
  PERSONA_OPTIONS,
  plural,
  usd,
  verdictLabel,
  verdictTone,
  fieldLabel,
  sourceLabel,
} from '../lib/format.js';
import { clamp, cn, isActivationTarget, isInOverlayLayer } from '../lib/utils.js';
import {
  FILTER_LABELS,
  FILTER_ORDER,
  SORT_LABELS,
  useOverlayOpen,
  useUi,
  type SortKey,
} from '../store/ui.js';
import { ActionBar } from '../components/ActionBar.js';
import { DetailPane } from '../components/DetailPane.js';
import { EmptyState } from '../components/EmptyState.js';
import { EvidenceThumb, EvidenceViewer } from '../components/EvidenceViewer.js';
import { editFocusedField, Field, moveFieldFocus } from '../components/Field.js';
import { ListRow, type RowChip } from '../components/ListRow.js';
import { RankedList, type RankedListHandle } from '../components/RankedList.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { Section } from '../components/Section.js';
import { SplitView } from '../components/SplitView.js';
import { StatusChip } from '../components/StatusChip.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Textarea } from '../components/ui/textarea.js';

import { applyView, STALE_DAYS } from '../lib/view.js';
const ROW_HEIGHT = 46;

export default function Review() {
  // Selector-based subscriptions: subscribing to the whole store would rerender
  // this screen (and its 5,000-row list) on every unrelated store write.
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const resetView = useUi((s) => s.resetView);
  const sort = useUi((s) => s.sort);
  const setSort = useUi((s) => s.setSort);
  const cycleSort = useUi((s) => s.cycleSort);
  const toggles = useUi((s) => s.toggles);
  const toggle = useUi((s) => s.toggle);
  const focusedIndex = useUi((s) => s.focusedIndex);
  const setFocusedIndex = useUi((s) => s.setFocusedIndex);
  const selectedId = useUi((s) => s.selectedId);
  const setSelectedId = useUi((s) => s.setSelectedId);
  const marked = useUi((s) => s.marked);
  const anchorIndex = useUi((s) => s.anchorIndex);
  const setAnchorIndex = useUi((s) => s.setAnchorIndex);
  const toggleMarked = useUi((s) => s.toggleMarked);
  const markRange = useUi((s) => s.markRange);
  const clearMarked = useUi((s) => s.clearMarked);
  const setLightboxIndex = useUi((s) => s.setLightboxIndex);
  const lightboxIndex = useUi((s) => s.lightboxIndex);
  const setCommands = useUi((s) => s.setCommands);
  const pushUndo = useUi((s) => s.pushUndo);
  const popUndo = useUi((s) => s.popUndo);
  const overlayOpen = useOverlayOpen();

  const { data: rows, isLoading, isError, error, refetch } = useCompanies();
  const all = useMemo(() => rows ?? [], [rows]);

  // Contact-name and req-title matches live only in the main process (FTS);
  // the debounced server id-set widens the instant client filter.
  const serverSearchIds = useServerSearchIds(search);
  const filtered = useMemo(() => applyView(all, filter, toggles, search, sort, serverSearchIds), [
    all,
    filter,
    toggles,
    search,
    sort,
    serverSearchIds,
  ]);

  const listRef = useRef<RankedListHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingIdRef = useRef<string | null>(null);

  const detailQuery = useCompany(selectedId);
  const detail = detailQuery.data ?? null;
  const prefetch = usePrefetchCompany();

  // Only the mutate functions are pulled out: the result objects from
  // useMutation are new on every render, and putting one in a dependency array
  // makes every memoised callback churn. (mutate/mutateAsync are stable refs.)
  const { mutate: patchCompany, mutateAsync: patchCompanyAsync } = usePatchCompany();
  const { mutate: bulkStatus } = useBulkCompanyStatus();
  const { mutate: resolveConflict } = useResolveConflict();
  const { mutateAsync: findContactsAsync } = useFindContacts();
  const { mutate: verifyContact } = useVerifyContact();
  const { mutate: generateDraft } = useGenerateDraft();

  // ── selection plumbing ────────────────────────────────────────────────────

  const focusAt = useCallback(
    (index: number, opts?: { select?: boolean }) => {
      if (filtered.length === 0) return;
      const i = clamp(index, 0, filtered.length - 1);
      setFocusedIndex(i);
      // A plain click or keyboard move re-plants the shift+click anchor here.
      setAnchorIndex(i);
      listRef.current?.scrollToIndex(i);
      if (opts?.select !== false) setSelectedId(filtered[i]?.id ?? null);
      prefetch(filtered[i + 1]?.id);
    },
    [filtered, prefetch, setAnchorIndex, setFocusedIndex, setSelectedId],
  );

  // Approving under the "Unreviewed" filter removes the record mid-flight, so
  // the record to land on is captured by id before the mutation and resolved to
  // an index once the filtered list settles.
  useEffect(() => {
    const pending = pendingIdRef.current;
    if (!pending || filtered.length === 0) return;
    const i = filtered.findIndex((r) => r.id === pending);
    pendingIdRef.current = null;
    if (i >= 0) {
      setFocusedIndex(i);
      setSelectedId(filtered[i]?.id ?? null);
      listRef.current?.scrollToIndex(i);
      prefetch(filtered[i + 1]?.id);
    } else {
      const j = clamp(focusedIndex, 0, filtered.length - 1);
      setFocusedIndex(j);
      setSelectedId(filtered[j]?.id ?? null);
    }
  }, [filtered, focusedIndex, prefetch, setFocusedIndex, setSelectedId]);

  // Keep a valid selection whenever the view changes underneath us.
  useEffect(() => {
    if (filtered.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (pendingIdRef.current) return;
    const i = filtered.findIndex((r) => r.id === selectedId);
    if (i >= 0) {
      if (i !== focusedIndex) setFocusedIndex(i);
      return;
    }
    const j = clamp(focusedIndex, 0, filtered.length - 1);
    setFocusedIndex(j);
    setSelectedId(filtered[j]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  const move = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return;
      focusAt(focusedIndex + delta);
    },
    [filtered.length, focusedIndex, focusAt],
  );

  // Marks and the shift+click anchor are positions in the CURRENT view. After
  // a filter/sort/search/toggle change they would map onto arbitrary rows of a
  // re-ordered list, so any view change drops them. The ref-compare skips the
  // mount run: marks survive a round-trip to another screen.
  const viewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify([filter, sort, search, toggles]);
    if (viewKeyRef.current !== null && viewKeyRef.current !== key) clearMarked();
    viewKeyRef.current = key;
  }, [filter, sort, search, toggles, clearMarked]);

  // ── actions ───────────────────────────────────────────────────────────────

  const setStatus = useCallback(
    (row: CompanyRow | CompanyDetail, status: 'approved' | 'rejected', advance: boolean) => {
      const prevStatus = row.status;
      const prevReviewed = row.reviewed;
      const nextId = advance ? (filtered[focusedIndex + 1]?.id ?? null) : null;

      patchCompany({ id: row.id, patch: { status, reviewed: true } });
      pushUndo({
        label: `${status === 'approved' ? 'Approved' : 'Rejected'} ${row.name}`,
        // mutateAsync: the undo invoker awaits this, and "Undone" must reflect
        // the IPC actually succeeding — the void mutate resolved immediately.
        run: async () => {
          await patchCompanyAsync({ id: row.id, patch: { status: prevStatus, reviewed: prevReviewed } });
        },
      });

      if (advance && nextId) {
        pendingIdRef.current = nextId;
        setSelectedId(nextId);
      }
    },
    [filtered, focusedIndex, patchCompany, patchCompanyAsync, pushUndo, setSelectedId],
  );

  const current = detail ?? (filtered[focusedIndex] as CompanyRow | undefined) ?? null;

  const approve = useCallback(() => {
    if (current) setStatus(current, 'approved', true);
  }, [current, setStatus]);

  const reject = useCallback(() => {
    if (current) setStatus(current, 'rejected', true);
  }, [current, setStatus]);

  const toggleReviewed = useCallback(() => {
    if (!current) return;
    const next = !current.reviewed;
    patchCompany({ id: current.id, patch: { reviewed: next } });
    pushUndo({
      label: `${next ? 'Marked' : 'Unmarked'} ${current.name} reviewed`,
      run: async () => {
        await patchCompanyAsync({ id: current.id, patch: { reviewed: !next } });
      },
    });
  }, [current, patchCompany, patchCompanyAsync, pushUndo]);

  const compose = useCallback(() => {
    if (!current) return;
    const primary = detail?.contacts.find((c) => c.isPrimary) ?? detail?.contacts[0];
    generateDraft(
      { companyId: current.id, contactId: primary?.id },
      {
        onSuccess: () =>
          toast.success(`Draft ready for ${current.name}`, {
            action: {
              label: 'Open Outreach',
              onClick: () => useUi.getState().setScreen('outreach'),
            },
          }),
      },
    );
  }, [current, detail, generateDraft]);

  const findMore = useCallback(() => {
    if (!current) return;
    toast.promise(findContactsAsync(current.id), {
      loading: `Searching for contacts at ${current.name}…`,
      success: (c) => `${c.length} contacts on file`,
      error: 'Contact discovery failed',
    });
  }, [current, findContactsAsync]);

  const reverify = useCallback(() => {
    if (!detail) return;
    const targets = detail.contacts.filter((c) => c.email);
    if (targets.length === 0) {
      toast.info('No email addresses to verify');
      return;
    }
    for (const c of targets) verifyContact({ id: c.id, companyId: detail.id });
    toast.info(`Verifying ${plural(targets.length, 'address', 'addresses')}…`);
  }, [detail, verifyContact]);

  const undo = useCallback(async () => {
    const entry = popUndo();
    if (!entry) {
      toast.info('Nothing to undo');
      return;
    }
    // Undo closures do real IPC (delete suppressions, restore statuses);
    // "Undone" must not appear before — or instead of — their failure.
    try {
      await entry.run();
      toast.success('Undone', { description: entry.label });
    } catch (e) {
      toast.error('Undo failed', { description: (e as Error).message });
    }
  }, [popUndo]);

  /** Field edits from the detail pane go through here so ⌘Z can revert them. */
  const patchFieldWithUndo = useCallback(
    (patch: CompanyPatch) => {
      if (!detail) return;
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) {
        before[key] = (detail as unknown as Record<string, unknown>)[key] ?? null;
      }
      patchCompany({ id: detail.id, patch });
      pushUndo({
        label: `Edited ${Object.keys(patch).map(fieldLabel).join(', ')} on ${detail.name}`,
        run: async () => {
          await patchCompanyAsync({ id: detail.id, patch: before as CompanyPatch, quiet: true });
        },
      });
    },
    [detail, patchCompany, patchCompanyAsync, pushUndo],
  );

  // ── keyboard map ──────────────────────────────────────────────────────────

  // An open Radix popover (provenance, conflict picker) or dropdown owns the
  // keyboard; without this, `a`/`x` would decide the record sitting behind it.
  const hk = {
    enabled: !overlayOpen,
    preventDefault: true,
    ignoreEventWhen: (e: KeyboardEvent) => isInOverlayLayer(e.target),
  } as const;

  useHotkeys('j,down', () => move(1), hk, [move]);
  useHotkeys('k,up', () => move(-1), hk, [move]);

  // Space is the one screen hotkey that collides with a native behaviour: it is
  // how the browser presses a focused button. Swallowing it unconditionally
  // would make every button on this screen unreachable from the keyboard, so
  // both the handler and its preventDefault stand down over activatable targets.
  const spaceIsOurs = useCallback(
    (e: KeyboardEvent) => !isActivationTarget(e.target) && !isInOverlayLayer(e.target),
    [],
  );
  useHotkeys(
    'space',
    () => filtered[focusedIndex] && setSelectedId(filtered[focusedIndex].id),
    { enabled: (e) => !overlayOpen && spaceIsOurs(e), preventDefault: spaceIsOurs },
    [filtered, focusedIndex, setSelectedId, overlayOpen, spaceIsOurs],
  );
  useHotkeys('a', approve, hk, [approve]);
  useHotkeys('x', reject, hk, [reject]);
  useHotkeys('r', toggleReviewed, hk, [toggleReviewed]);
  useHotkeys('c', compose, hk, [compose]);
  useHotkeys('f', findMore, hk, [findMore]);
  useHotkeys('v', reverify, hk, [reverify]);
  useHotkeys(
    'g',
    () => {
      if (detail?.screenshots.length) setLightboxIndex(0);
      else if (detail) toast.info('No evidence captured for this company yet');
    },
    hk,
    [detail, setLightboxIndex],
  );
  useHotkeys('s', cycleSort, hk, [cycleSort]);
  useHotkeys('mod+z', undo, { ...hk, enableOnFormTags: false }, [undo]);

  useHotkeys(
    '1,2,3,4,5',
    (e) => {
      const idx = Number(e.key) - 1;
      const next = FILTER_ORDER[idx];
      if (next) setFilter(next);
    },
    { ...hk, useKey: true },
    [setFilter],
  );

  useHotkeys(
    '/',
    () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { ...hk, useKey: true },
    [],
  );

  useHotkeys('e', () => {
    if (!editFocusedField()) moveFieldFocus(1);
  }, hk, []);

  // Tab walks fields only while focus is already inside the detail pane's
  // field context; everywhere else (filter chips, search, buttons) it keeps its
  // native meaning, so preventDefault is applied conditionally in the handler.
  const fieldWalk = useCallback((dir: 1 | -1, e: KeyboardEvent) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest('[data-detail-pane]')) return;
    e.preventDefault();
    moveFieldFocus(dir);
  }, []);
  useHotkeys('tab', (e) => fieldWalk(1, e), { enabled: !overlayOpen }, [fieldWalk, overlayOpen]);
  useHotkeys('shift+tab', (e) => fieldWalk(-1, e), { enabled: !overlayOpen }, [fieldWalk, overlayOpen]);

  useHotkeys(
    'escape',
    () => {
      if (marked.length) clearMarked();
      if (document.activeElement === searchRef.current) searchRef.current?.blur();
    },
    { enabled: !overlayOpen, enableOnFormTags: ['input'] },
    [marked.length, clearMarked],
  );

  // ── command palette contributions ─────────────────────────────────────────

  useEffect(() => {
    setCommands([
      { id: 'approve', label: 'Approve and advance', group: 'Review', hint: 'a', run: approve, disabled: !current },
      { id: 'reject', label: 'Reject and advance', group: 'Review', hint: 'x', run: reject, disabled: !current },
      { id: 'reviewed', label: 'Toggle reviewed', group: 'Review', hint: 'r', run: toggleReviewed, disabled: !current },
      { id: 'compose', label: 'Compose email for this company', group: 'Review', hint: 'c', run: compose, disabled: !current },
      { id: 'find', label: 'Find more contacts', group: 'Review', hint: 'f', run: findMore, disabled: !current },
      { id: 'verify', label: 'Re-verify emails', group: 'Review', hint: 'v', run: reverify, disabled: !detail },
      { id: 'undo', label: 'Undo last action', group: 'Review', hint: '⌘Z', run: undo },
      ...FILTER_ORDER.map((f, i) => ({
        id: `filter-${f}`,
        label: `Filter: ${FILTER_LABELS[f]}`,
        group: 'View',
        hint: String(i + 1),
        keywords: 'filter show',
        run: () => setFilter(f),
      })),
      ...(Object.keys(SORT_LABELS) as SortKey[]).map((s) => ({
        id: `sort-${s}`,
        label: `Sort by ${SORT_LABELS[s]}`,
        group: 'View',
        keywords: 'order rank',
        run: () => setSort(s),
      })),
    ]);
    return () => setCommands([]);
  }, [approve, reject, toggleReviewed, compose, findMore, reverify, undo, current, detail, setCommands, setFilter, setSort]);

  // ── bulk ──────────────────────────────────────────────────────────────────

  const onRowSelect = (id: string, index: number, mods?: { shift: boolean; meta: boolean }) => {
    if (mods?.meta) {
      toggleMarked(id, index);
      return;
    }
    if (mods?.shift) {
      // Range from the stored anchor. The row's onMouseDown has already moved
      // focusedIndex to the shift-clicked row, so the anchor — planted by the
      // last plain click or keyboard move — is the only honest range origin.
      // It deliberately stays put so another shift+click re-aims from it.
      const from = clamp(anchorIndex ?? index, 0, filtered.length - 1);
      const [lo, hi] = from <= index ? [from, index] : [index, from];
      markRange(filtered.slice(lo, hi + 1).map((r) => r.id));
      return;
    }
    clearMarked();
    focusAt(index); // also plants the anchor on the clicked row
  };

  /** Snapshot of the fields a status-changing bulk action clobbers. */
  const snapshotStatuses = useCallback(
    (ids: string[]) =>
      all
        .filter((r) => ids.includes(r.id))
        .map((r) => ({ id: r.id, status: r.status, reviewed: r.reviewed })),
    [all],
  );

  /**
   * Restore a status snapshot, quietly, collecting failures into ONE error
   * (surfaced by the undo invoker) instead of a toast per row.
   */
  const restoreStatuses = useCallback(
    async (prev: { id: string; status: string; reviewed: boolean }[]) => {
      const results = await Promise.allSettled(
        prev.map((p) =>
          patchCompanyAsync({
            id: p.id,
            patch: { status: p.status, reviewed: p.reviewed },
            quiet: true,
          }),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) throw new Error(`${failed} of ${prev.length} could not be restored`);
    },
    [patchCompanyAsync],
  );

  const bulk = (status: 'approved' | 'rejected') => {
    const ids = [...marked];
    if (!ids.length) return;
    const prev = snapshotStatuses(ids);
    const label = `${plural(ids.length, 'company', 'companies')} ${status}`;
    bulkStatus({ ids, status });
    pushUndo({ label, run: () => restoreStatuses(prev) });
    clearMarked();
    toast.success(label);
  };

  const suppressMarked = async () => {
    const ids = [...marked];
    const domains = [
      ...new Set(all.filter((r) => ids.includes(r.id) && r.domain).map((r) => r.domain as string)),
    ];
    if (!domains.length) {
      toast.error('Selected companies have no domain to suppress');
      return;
    }
    // The main process suppresses EVERY company on a suppressed domain, not
    // just the marked rows, so the restore snapshot covers all of them.
    const domainSet = new Set(domains);
    const affected = all
      .filter((r) => r.domain && domainSet.has(r.domain))
      .map((r) => ({ id: r.id, status: r.status, reviewed: r.reviewed }));
    try {
      const before = new Set((await api.listSuppressions()).map((r) => r.id));
      for (const d of domains) await api.addSuppression('domain', d, 'manual');
      bulkStatus({ ids, status: 'suppressed' });
      // Diff instead of value lookup: undo may only delete rows THIS action
      // created. A pre-existing row for the same domain — or a replied-no
      // opt-out recorded between action and undo — must survive.
      const createdIds = (await api.listSuppressions())
        .filter((r) => !before.has(r.id))
        .map((r) => r.id);
      pushUndo({
        label: `Suppressed ${plural(domains.length, 'domain')}`,
        run: async () => {
          for (const sid of createdIds) await api.removeSuppression(sid);
          // removeSuppression resets matching companies to 'scored'; put every
          // affected company back to its snapshotted status instead. Cache
          // freshness rides on the company+suppression events main emits.
          await restoreStatuses(affected);
        },
      });
      clearMarked();
      toast.success(`Suppressed ${plural(domains.length, 'domain')}`);
    } catch (e) {
      toast.error('Could not suppress', { description: (e as Error).message });
    }
  };

  const exportMarkedCsv = () => {
    const ids = [...marked];
    void api
      .exportCsv('companies', ids.length ? ids : undefined)
      .then((path) =>
        toast.success(ids.length ? `Exported ${plural(ids.length, 'selected company', 'selected companies')}` : 'Exported all companies', {
          description: path,
        }),
      )
      .catch((e: Error) => toast.error('Export failed', { description: e.message }));
  };

  const rediscoverMarked = () => {
    const ids = [...marked];
    if (!ids.length) return;
    toast.promise(
      (async () => {
        let onFile = 0;
        for (const id of ids) onFile += (await api.findContacts(id)).length;
        return onFile;
      })(),
      {
        loading: `Re-running contact discovery for ${plural(ids.length, 'company', 'companies')}…`,
        success: (n) => `Done — ${plural(n, 'contact')} on file across the selection`,
        error: 'Contact discovery failed',
      },
    );
  };

  // ── render ────────────────────────────────────────────────────────────────

  const left = (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div className="flex flex-wrap gap-1">
          {FILTER_ORDER.map((f, i) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                filter === f
                  ? 'border-primary bg-primary/15 font-medium text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {FILTER_LABELS[f]}
              <kbd className="kbd h-3.5 min-w-3 px-1 text-[9px]">{i + 1}</kbd>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          <ToggleChip
            active={toggles.hasVerifiedEmail}
            onClick={() => toggle('hasVerifiedEmail')}
            label="Verified email"
          />
          <ToggleChip
            active={toggles.noInhouseTa}
            onClick={() => toggle('noInhouseTa')}
            label="No in-house TA"
          />
          <ToggleChip
            active={toggles.staleOnly}
            onClick={() => toggle('staleOnly')}
            label={`Reqs >${STALE_DAYS}d`}
          />
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies…"
            spellCheck={false}
            className="h-7 pr-14 pl-7 text-[12px]"
          />
          <kbd className="kbd pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</kbd>
        </div>

        <button
          type="button"
          onClick={cycleSort}
          title="Cycle sort"
          className="flex h-5 items-center justify-between rounded px-1 text-[10px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="tabular-nums">
            {num(filtered.length)} of {num(all.length)}
          </span>
          <span className="flex items-center gap-1">
            {SORT_LABELS[sort]}
            <kbd className="kbd h-3.5 min-w-3 px-1 text-[9px]">s</kbd>
          </span>
        </button>
      </div>

      <RankedList<CompanyRow>
        ref={listRef}
        items={filtered}
        selectedId={selectedId}
        focusedIndex={focusedIndex}
        onFocus={setFocusedIndex}
        onSelect={onRowSelect}
        estimateSize={ROW_HEIGHT}
        emptyState={
          isLoading ? (
            <EmptyState icon={<Building2 />} title="Loading companies…" />
          ) : isError ? (
            <EmptyState
              icon={<TriangleAlert />}
              title="Could not load companies"
              description={String((error as Error)?.message ?? '')}
              action={
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Retry
                </Button>
              }
            />
          ) : all.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="No companies yet"
              description="Run the discovery sources on the Pipeline screen to populate the database."
              action={
                <Button size="sm" onClick={() => useUi.getState().setScreen('pipeline')}>
                  Open Pipeline
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Search />}
              title="Nothing matches this view"
              description="Try a different filter, drop a toggle, or clear the search."
              action={
                <Button size="sm" variant="outline" onClick={resetView}>
                  Reset filters
                </Button>
              }
            />
          )
        }
        renderRow={(row, index, state) => (
          <ListRow
            score={row.qualityScore}
            title={row.name}
            subtitle={rowSubtitle(row)}
            chips={rowChips(row)}
            selected={state.selected}
            focused={state.focused}
            marked={marked.includes(row.id)}
            dimmed={!!row.disqualified}
          />
        )}
      />

      {marked.length > 0 && (
        <ActionBar
          className="h-9 bg-primary/10"
          actions={[
            { key: 'A', label: `Approve ${marked.length}`, onClick: () => bulk('approved') },
            {
              key: 'X',
              label: `Reject ${marked.length}`,
              onClick: () => bulk('rejected'),
              tone: 'destructive',
            },
            { key: '⛔', label: 'Suppress domains', onClick: suppressMarked },
            { label: 'Re-discover contacts', onClick: rediscoverMarked },
            { label: 'Export CSV', onClick: exportMarkedCsv },
          ]}
          trailing={
            <Button size="xs" variant="ghost" onClick={clearMarked}>
              Clear
            </Button>
          }
        />
      )}
    </div>
  );

  const right = (
    <div className="flex h-full min-h-0 flex-col">
      {detail ? (
        <>
          <DetailPane>
            <CompanyHeader detail={detail} />
            <WhySection detail={detail} />
            <CompanyFieldsSection
              detail={detail}
              onPatch={patchFieldWithUndo}
              onResolve={(field, obsId) =>
                resolveConflict({ entityId: detail.id, field, observationId: obsId })
              }
            />
            <ReqsSection reqs={detail.reqs} />
            <ContactsSection detail={detail} />
            <EvidenceSection detail={detail} onOpen={setLightboxIndex} />
            <NotesSection
              detail={detail}
              onSaveNotes={(notes) => patchFieldWithUndo({ notes })}
            />
            <div className="h-8" />
          </DetailPane>

          <ActionBar
            actions={[
              { key: 'a', label: 'Approve', onClick: approve, icon: <Check /> },
              { key: 'x', label: 'Reject', onClick: reject, tone: 'destructive', icon: <X /> },
              {
                key: 'r',
                label: detail.reviewed ? 'Reviewed' : 'Mark reviewed',
                onClick: toggleReviewed,
              },
              { key: 'c', label: 'Compose', onClick: compose, icon: <Send /> },
              { key: 'f', label: 'Find contacts', onClick: findMore, icon: <UserPlus /> },
              { key: 'v', label: 'Re-verify', onClick: reverify, icon: <RefreshCw /> },
            ]}
            trailing={
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {filtered.length ? focusedIndex + 1 : 0} / {num(filtered.length)}
              </span>
            }
          />
        </>
      ) : (
        <EmptyState
          icon={<Building2 />}
          title={detailQuery.isFetching ? 'Loading record…' : 'No record selected'}
          description={
            filtered.length
              ? 'Press j and k to move through the list. Approving advances automatically.'
              : undefined
          }
        />
      )}
    </div>
  );

  return (
    <>
      <SplitView left={left} right={right} storageKey="review" defaultLeft={400} />
      <EvidenceViewer
        shots={detail?.screenshots ?? []}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Left list helpers
// ─────────────────────────────────────────────────────────────────────────────

function ToggleChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-5 rounded-full border px-2 text-[10px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-info bg-info/15 text-foreground'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function rowSubtitle(row: CompanyRow): string {
  const bits: string[] = [];
  if (row.domain) bits.push(row.domain);
  if (row.headcount != null) bits.push(`${num(row.headcount)} ppl`);
  bits.push(plural(row.openReqCount, 'req'));
  if (row.estimatedFeeUsd) bits.push(`~${usd(row.estimatedFeeUsd)}`);
  return bits.join(' · ');
}

function rowChips(row: CompanyRow): RowChip[] {
  const chips: RowChip[] = [];
  if (row.disqualified) chips.push({ label: '⛔', tone: 'red', title: row.disqualified });
  if (row.hasConflict) chips.push({ label: '⚠', tone: 'amber', title: 'Sources disagree' });
  if (row.verifiedContactCount > 0) {
    chips.push({
      label: '✉',
      tone: 'green',
      title: `${row.verifiedContactCount} verified ${row.verifiedContactCount === 1 ? 'address' : 'addresses'}`,
    });
  }
  if (row.maxDaysOpen != null && row.maxDaysOpen >= STALE_DAYS) {
    chips.push({ label: `${row.maxDaysOpen}d`, tone: 'amber', title: 'Oldest open req' });
  }
  if (row.status === 'approved') chips.push({ label: '✓', tone: 'green', title: 'Approved' });
  else if (row.status === 'rejected') chips.push({ label: '✕', tone: 'red', title: 'Rejected' });
  else if (!row.reviewed) chips.push({ label: '●', tone: 'default', title: 'Unreviewed' });
  return chips;
}

// applyView lives in lib/view.ts (pure, node-testable).

// ─────────────────────────────────────────────────────────────────────────────
// Detail sections
// ─────────────────────────────────────────────────────────────────────────────

function CompanyHeader({ detail }: { detail: CompanyDetail }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3 py-2.5">
      <ScoreBadge score={detail.qualityScore} breakdown={detail.scoreBreakdown} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h1 data-selectable className="truncate text-[15px] leading-tight font-semibold">
            {detail.name}
          </h1>
          {detail.ycBatch && <StatusChip label={`YC ${detail.ycBatch}`} tone="blue" />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {detail.domain && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => openExternal(`https://${detail.domain}`)}
            >
              {detail.domain}
            </button>
          )}
          {detail.headcount != null && <span>· {num(detail.headcount)} people</span>}
          {detail.hqLocation && <span>· {detail.hqLocation}</span>}
          {detail.industry && <span>· {detail.industry}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <StatusChip
            label={detail.status}
            tone={
              detail.status === 'approved' ? 'green' : detail.status === 'rejected' ? 'red' : 'default'
            }
          />
          {detail.reviewed && <StatusChip label="reviewed" tone="blue" />}
          {detail.atsPlatform && <StatusChip label={detail.atsPlatform} />}
          {detail.hasConflict && <StatusChip label="conflicts" tone="amber" />}
          {detail.disqualified && <StatusChip label={detail.disqualified} tone="red" />}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {detail.estimatedFeeUsd != null && (
          <span className="font-mono text-[13px] font-semibold tabular-nums">
            {usd(detail.estimatedFeeUsd)}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">updated {ago(detail.updatedAt)}</span>
      </div>
    </div>
  );
}

function WhySection({ detail }: { detail: CompanyDetail }) {
  return (
    <Section title="Why this company" storageKey="why">
      <p data-selectable className="text-[12px] leading-relaxed text-balance">
        {detail.scoreHeadline ?? 'No score explanation available yet.'}
      </p>
      {detail.scoreBreakdown.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {detail.scoreBreakdown.map((c) => (
            <li key={c.key} className="grid grid-cols-[128px_60px_minmax(0,1fr)] items-center gap-2">
              <span className="truncate text-[11px] text-muted-foreground">{c.label}</span>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${clamp((c.points / c.max) * 100, 0, 100)}%` }}
                />
              </div>
              <span className="truncate text-[11px] text-muted-foreground">{c.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CompanyFieldsSection({
  detail,
  onPatch,
  onResolve,
}: {
  detail: CompanyDetail;
  onPatch: (patch: CompanyPatch) => void;
  onResolve: (field: string, obsId: number) => void;
}) {
  const byField = useMemo(() => {
    const m = new Map<string, ResolvedField>();
    for (const f of detail.fields) m.set(f.field, f);
    return m;
  }, [detail.fields]);

  const prov = (name: string) => byField.get(name);

  const field = (
    label: string,
    name: string,
    value: string | null,
    opts?: { type?: 'text' | 'number' | 'url' | 'email'; parse?: (v: string) => unknown; readOnly?: boolean },
  ) => {
    const p = prov(name);
    return (
      <Field
        key={name}
        label={label}
        value={value}
        type={opts?.type}
        editable={!opts?.readOnly}
        onSave={
          opts?.readOnly
            ? undefined
            : (v) =>
                onPatch({
                  [name]: opts?.parse ? opts.parse(v) : v === '' ? null : v,
                } as CompanyPatch)
        }
        provenance={p}
        conflicting={p?.conflicting}
        onResolveConflict={p ? (obsId) => onResolve(name, obsId) : undefined}
      />
    );
  };

  const toNumber = (v: string) => {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return v.trim() === '' || Number.isNaN(n) ? null : Math.round(n);
  };

  return (
    <Section title="Company" storageKey="company">
      <div className="flex flex-col gap-0.5">
        {field('Name', 'name', detail.name, {
          // CompanyPatch.name is non-nullable; emptying the field keeps the
          // current name instead of writing null.
          parse: (v) => (v.trim() === '' ? detail.name : v.trim()),
        })}
        {field('Domain', 'domain', detail.domain)}
        {field('Website', 'website', detail.website, { type: 'url' })}
        {field('Headcount', 'headcount', detail.headcount?.toString() ?? null, {
          type: 'number',
          parse: toNumber,
        })}
        {field('Industry', 'industry', detail.industry)}
        {field('HQ location', 'hqLocation', detail.hqLocation)}
        {field('Funding stage', 'fundingStage', detail.fundingStage)}
        {field('Last round', 'lastRoundAt', detail.lastRoundAt ? dateShort(detail.lastRoundAt) : null, {
          readOnly: true,
        })}
        {field('ATS platform', 'atsPlatform', detail.atsPlatform, { readOnly: true })}
        {field('Careers URL', 'careersUrl', detail.careersUrl, { type: 'url' })}
        {field('LinkedIn URL', 'linkedinUrl', detail.linkedinUrl, { type: 'url' })}
        {field('In-house recruiters', 'recruiterCount', detail.recruiterCount?.toString() ?? null, {
          type: 'number',
          parse: toNumber,
        })}

        <div className="grid min-h-6 grid-cols-[104px_minmax(0,1fr)] items-center gap-2 rounded px-1 py-0.5">
          <span className="truncate text-[11px] text-muted-foreground">Has in-house TA</span>
          <div className="flex gap-1">
            {(
              [
                ['Yes', true],
                ['No', false],
                ['Unknown', null],
              ] as const
            ).map(([label, v]) => (
              <button
                key={label}
                type="button"
                onClick={() => onPatch({ hasInhouseTa: v })}
                className={cn(
                  'h-5 rounded border px-1.5 text-[10px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  detail.hasInhouseTa === v
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

function ReqsSection({ reqs }: { reqs: ReqRow[] }) {
  const open = reqs.filter((r) => !r.closedAt);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const toggleReq = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Section title="Open requisitions" count={open.length} storageKey="reqs">
      {open.length === 0 ? (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">No open requisitions on file.</p>
      ) : (
        <ul className="flex flex-col">
          {open.map((r) => {
            const isOpen = expanded.has(r.id);
            const band = compBand(r.compMin, r.compMax);
            return (
              <li key={r.id} className="border-b border-border/50 last:border-0">
                <div className="flex items-start gap-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => toggleReq(r.id)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'Collapse description' : 'Expand description'}
                    className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDown className={cn('size-3 transition-transform', !isOpen && '-rotate-90')} />
                  </button>

                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span data-selectable className="truncate text-[12px] font-medium">
                        {r.title}
                      </span>
                      {r.noAgencyDisclaimer && (
                        <StatusChip label="no-agency" tone="red" title="JD forbids agency submissions" />
                      )}
                      {r.namedContact && (
                        <StatusChip label="named contact" tone="green" title={r.namedContact} />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                      {r.department && <span>{r.department}</span>}
                      {r.location && <span>· {r.location}</span>}
                      {r.isRemote && <span>· remote</span>}
                      {band && <span>· {band}</span>}
                      {r.estimatedFeeUsd != null && <span>· fee ~{usd(r.estimatedFeeUsd)}</span>}
                      {r.repostCount > 0 && <span>· reposted {r.repostCount}×</span>}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {r.daysOpen != null && (
                      <StatusChip
                        label={`${r.daysOpen}d`}
                        tone={r.daysOpen >= STALE_DAYS * 2 ? 'red' : r.daysOpen >= STALE_DAYS ? 'amber' : 'default'}
                        title={`Open ${r.daysOpen} days`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => openExternal(r.url)}
                      aria-label="Open job posting"
                      className="flex size-4 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ExternalLink className="size-3" />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div
                    data-selectable
                    className="mb-2 ml-6 max-h-72 overflow-y-auto rounded-md border border-border bg-surface-2 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
                  >
                    {r.description?.trim() || 'No description captured for this requisition.'}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ContactsSection({ detail }: { detail: CompanyDetail }) {
  const patchContact = usePatchContact();
  const addContact = useAddContact();
  const deleteContact = useDeleteContact();
  const verifyContact = useVerifyContact();
  const findContacts = useFindContacts();

  const contacts = [...detail.contacts].sort(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || (b.contactScore ?? -1) - (a.contactScore ?? -1),
  );

  return (
    <Section
      title="Decision makers"
      count={contacts.length}
      storageKey="contacts"
      actions={
        <>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Add contact"
            onClick={() =>
              addContact.mutate({ companyId: detail.id, patch: { fullName: 'New contact' } })
            }
          >
            <Plus />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Find more contacts"
            onClick={() => findContacts.mutate(detail.id)}
          >
            <UserPlus />
          </Button>
        </>
      }
    >
      {contacts.length === 0 ? (
        <EmptyState
          className="py-6"
          icon={<UserPlus />}
          title="No contacts yet"
          description="Run contact discovery to find the people who decide on agency spend."
          action={
            <Button size="sm" variant="outline" onClick={() => findContacts.mutate(detail.id)}>
              Find contacts
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              onPatch={(patch) => patchContact.mutate({ id: c.id, companyId: detail.id, patch })}
              onDelete={() => deleteContact.mutate({ id: c.id, companyId: detail.id })}
              onVerify={() => verifyContact.mutate({ id: c.id, companyId: detail.id })}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ContactCard({
  contact,
  onPatch,
  onDelete,
  onVerify,
}: {
  contact: ContactRow;
  onPatch: (patch: ContactPatch) => void;
  onDelete: () => void;
  onVerify: () => void;
}) {
  return (
    <li className="rounded-md border border-border bg-surface-2 p-2">
      <div className="mb-1 flex items-center gap-1.5">
        <button
          type="button"
          aria-label={contact.isPrimary ? 'Primary contact' : 'Make primary contact'}
          onClick={() => onPatch({ isPrimary: !contact.isPrimary })}
          className={cn(
            'flex size-5 items-center justify-center rounded outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            contact.isPrimary ? 'text-warn' : 'text-muted-foreground/40',
          )}
        >
          <Star className={cn('size-3.5', contact.isPrimary && 'fill-current')} />
        </button>

        <span data-selectable className="truncate text-[12px] font-medium">
          {contact.fullName}
        </span>

        <StatusChip
          label={verdictLabel(contact.emailVerdict)}
          tone={verdictTone(contact.emailVerdict)}
          title={
            contact.emailVerifiedAt ? `Verified ${ago(contact.emailVerifiedAt)}` : 'Not yet verified'
          }
        />
        {contact.contactScore != null && (
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
            {contact.contactScore}
          </span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          <Button size="icon-sm" variant="ghost" title="Re-verify email" onClick={onVerify}>
            <RefreshCw />
          </Button>
          {contact.linkedinUrl && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Open LinkedIn profile"
              onClick={() => openExternal(contact.linkedinUrl as string)}
            >
              <ExternalLink />
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" title="Delete contact" onClick={onDelete}>
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        <Field
          label="Name"
          value={contact.fullName}
          editable
          onSave={(v) => onPatch({ fullName: v })}
        />
        <Field label="Title" value={contact.title} editable onSave={(v) => onPatch({ title: v || null })} />

        <div className="grid min-h-6 grid-cols-[104px_minmax(0,1fr)] items-center gap-2 rounded px-1 py-0.5">
          <span className="truncate text-[11px] text-muted-foreground">Persona</span>
          <Select
            value={contact.persona ?? 'other'}
            onValueChange={(v) => onPatch({ persona: v as Persona })}
          >
            <SelectTrigger className="h-6 max-w-[220px] text-[12px]">
              <SelectValue placeholder="Unclassified">{personaLabel(contact.persona)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PERSONA_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Field
          label="Email"
          value={contact.email}
          type="email"
          editable
          mono
          placeholder="not found"
          onSave={(v) => onPatch({ email: v || null })}
          render={
            contact.email ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span data-selectable className="truncate font-mono">
                  {contact.email}
                </span>
                {contact.emailSource && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {sourceLabel(contact.emailSource)}
                  </span>
                )}
              </span>
            ) : undefined
          }
        />
        <Field label="Phone" value={contact.phone} editable mono onSave={(v) => onPatch({ phone: v || null })} />
        <Field
          label="LinkedIn"
          value={contact.linkedinUrl}
          type="url"
          editable
          onSave={(v) => onPatch({ linkedinUrl: v || null })}
        />
      </div>
    </li>
  );
}

function EvidenceSection({
  detail,
  onOpen,
}: {
  detail: CompanyDetail;
  onOpen: (index: number) => void;
}) {
  const sources = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of detail.fields) {
      for (const o of f.observations) m.set(o.source, Math.max(m.get(o.source) ?? 0, o.observedAt));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [detail.fields]);

  const links = [
    detail.website && { label: 'Website', url: detail.website },
    detail.careersUrl && { label: 'Careers page', url: detail.careersUrl },
    detail.linkedinUrl && { label: 'LinkedIn', url: detail.linkedinUrl },
  ].filter(Boolean) as { label: string; url: string }[];

  return (
    <Section title="Evidence" count={detail.screenshots.length} storageKey="evidence" defaultOpen={false}>
      {detail.screenshots.length > 0 && (
        <div className="mb-2 grid grid-cols-4 gap-1.5">
          {detail.screenshots.map((s, i) => (
            <EvidenceThumb key={s.id} shot={s} onClick={() => onOpen(i)} />
          ))}
        </div>
      )}

      {links.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {links.map((l) => (
            <Button key={l.label} size="xs" variant="outline" onClick={() => openExternal(l.url)}>
              <ExternalLink />
              {l.label}
              <span className="text-muted-foreground">{hostOf(l.url)}</span>
            </Button>
          ))}
        </div>
      )}

      {sources.length === 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground">No source observations recorded.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {sources.map(([src, at]) => (
            <li key={src} className="flex items-center justify-between gap-2 px-1 text-[11px]">
              <span>{sourceLabel(src)}</span>
              <span className="text-muted-foreground">{ago(at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function NotesSection({
  detail,
  onSaveNotes,
}: {
  detail: CompanyDetail;
  onSaveNotes: (notes: string) => void;
}) {
  const [draft, setDraft] = useState(detail.notes ?? '');
  const idRef = useRef(detail.id);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (idRef.current !== detail.id) {
      idRef.current = detail.id;
      setDraft(detail.notes ?? '');
      return;
    }
    // Same record, notes changed externally (⌘Z undo, event-driven refetch):
    // adopt the new value unless the operator is mid-edit in the textarea —
    // otherwise the stale local buffer would be re-saved over it on blur.
    // Unfocused implies no unsaved keystrokes, since blur is what saves.
    if (document.activeElement !== areaRef.current) setDraft(detail.notes ?? '');
  }, [detail.id, detail.notes]);

  const history = useMemo(() => {
    const rows = detail.fields.flatMap((f) =>
      f.observations.map((o) => ({ field: f.field, ...o })),
    );
    return rows.sort((a, b) => b.observedAt - a.observedAt).slice(0, 40);
  }, [detail.fields]);

  return (
    <Section title="Notes & history" storageKey="notes" defaultOpen={false}>
      <Textarea
        ref={areaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== (detail.notes ?? '') && onSaveNotes(draft)}
        placeholder="Anything worth remembering before you write to them…"
        className="mb-2 min-h-14 text-[12px]"
      />

      {history.length === 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground">No field history yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {history.map((h) => (
            <li key={`${h.field}-${h.id}`} className="flex items-baseline gap-1.5 px-1 text-[11px]">
              <span className="shrink-0 text-muted-foreground">{fieldLabel(h.field)}</span>
              <span data-selectable className="min-w-0 flex-1 truncate font-mono">
                {h.value ?? '∅'}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {sourceLabel(h.source)} · {ago(h.observedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
