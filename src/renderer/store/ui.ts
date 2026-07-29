import { create } from 'zustand';

import type { CompanyFilter } from '../../shared/ipc.js';
import { getTheme, readJson, setTheme, writeJson, type Theme } from '../lib/utils.js';

export type Screen = 'review' | 'outreach' | 'pipeline' | 'settings' | 'setup';

export const OUTREACH_TABS = ['drafts', 'queue', 'sent', 'replies'] as const;
export type OutreachTab = (typeof OUTREACH_TABS)[number];

/** A persisted tab that is no longer in the enum falls back to a real one. */
export function normalizeOutreachTab(v: string | null | undefined): OutreachTab {
  return (OUTREACH_TABS as readonly string[]).includes(v ?? '') ? (v as OutreachTab) : 'drafts';
}

export type SortKey = 'score' | 'reqs' | 'days_open' | 'fee' | 'recent' | 'name';

export const SORT_CYCLE: SortKey[] = ['score', 'reqs', 'days_open', 'fee', 'recent', 'name'];

export const SORT_LABELS: Record<SortKey, string> = {
  score: 'Quality score',
  reqs: 'Open reqs',
  days_open: 'Days open',
  fee: 'Fee potential',
  recent: 'Recently discovered',
  name: 'Name A–Z',
};

export const FILTER_ORDER: CompanyFilter[] = [
  'all',
  'unreviewed',
  'conflicts',
  'approved',
  'rejected',
];

export const FILTER_LABELS: Record<CompanyFilter, string> = {
  all: 'All',
  unreviewed: 'Unreviewed',
  conflicts: 'Conflicts',
  approved: 'Approved',
  rejected: 'Rejected',
};

export interface ReviewToggles {
  hasVerifiedEmail: boolean;
  noInhouseTa: boolean;
  staleOnly: boolean;
}

/** A palette-addressable action. Screens publish their own while mounted. */
export interface Command {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

export interface UndoEntry {
  id: string;
  label: string;
  at: number;
  run: () => void | Promise<void>;
}

const PREFS_KEY = 'recruitai.review.prefs';

interface Prefs {
  filter: CompanyFilter;
  sort: SortKey;
  toggles: ReviewToggles;
}

const defaultPrefs: Prefs = {
  filter: 'unreviewed',
  sort: 'score',
  toggles: { hasVerifiedEmail: false, noInhouseTa: false, staleOnly: false },
};

const loaded = readJson<Prefs>(PREFS_KEY, defaultPrefs);
const initialPrefs: Prefs = {
  filter: FILTER_ORDER.includes(loaded.filter) ? loaded.filter : defaultPrefs.filter,
  sort: SORT_CYCLE.includes(loaded.sort) ? loaded.sort : defaultPrefs.sort,
  toggles: { ...defaultPrefs.toggles, ...loaded.toggles },
};

interface UiState {
  screen: Screen;
  setScreen: (s: Screen) => void;

  // Review list state
  filter: CompanyFilter;
  setFilter: (f: CompanyFilter) => void;
  search: string;
  setSearch: (s: string) => void;
  sort: SortKey;
  setSort: (s: SortKey) => void;
  cycleSort: () => void;
  toggles: ReviewToggles;
  toggle: (k: keyof ReviewToggles) => void;
  /** Everything the left rail narrows the list with, back to "show me all of it". */
  resetView: () => void;

  /**
   * The focused row is state, not DOM focus: virtualized rows unmount as they
   * scroll out, taking any real focus with them.
   */
  focusedIndex: number;
  setFocusedIndex: (i: number) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;

  /**
   * Multi-select for bulk actions. The anchor is where a shift+click range
   * starts: a plain click or keyboard selection move sets it, a cmd+click
   * toggle sets it, and shift+click ranges FROM it without moving it — so
   * repeated shift+clicks all extend from the same origin.
   */
  marked: string[];
  anchorIndex: number | null;
  setMarked: (ids: string[]) => void;
  setAnchorIndex: (index: number | null) => void;
  toggleMarked: (id: string, index: number) => void;
  markRange: (ids: string[]) => void;
  clearMarked: () => void;

  /** Theme choice — the single source of truth the sidebar, palette and Toaster read. */
  theme: Theme;
  setThemeChoice: (t: Theme) => void;

  // Global overlays
  paletteOpen: boolean;
  setPaletteOpen: (o: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (o: boolean) => void;
  /** Non-null means the evidence lightbox is open at that screenshot index. */
  lightboxIndex: number | null;
  setLightboxIndex: (i: number | null) => void;

  commands: Command[];
  setCommands: (c: Command[]) => void;

  undoStack: UndoEntry[];
  pushUndo: (e: Omit<UndoEntry, 'id' | 'at'>) => void;
  popUndo: () => UndoEntry | null;
}

function persist(state: Pick<UiState, 'filter' | 'sort' | 'toggles'>): void {
  writeJson(PREFS_KEY, { filter: state.filter, sort: state.sort, toggles: state.toggles });
}

export const useUi = create<UiState>((set, get) => ({
  screen: 'review',
  setScreen: (screen) => set({ screen }),

  filter: initialPrefs.filter,
  setFilter: (filter) => {
    set({ filter });
    persist(get());
  },
  search: '',
  setSearch: (search) => set({ search }),
  sort: initialPrefs.sort,
  setSort: (sort) => {
    set({ sort });
    persist(get());
  },
  cycleSort: () => {
    const next = SORT_CYCLE[(SORT_CYCLE.indexOf(get().sort) + 1) % SORT_CYCLE.length];
    set({ sort: next });
    persist(get());
  },
  toggles: initialPrefs.toggles,
  toggle: (k) => {
    set({ toggles: { ...get().toggles, [k]: !get().toggles[k] } });
    persist(get());
  },
  // The toggle chips narrow the list exactly as hard as the filter and the
  // search do, so a "reset" that left them set would leave the operator staring
  // at the same empty list they just tried to escape.
  resetView: () => {
    set({ filter: 'all', search: '', toggles: { ...defaultPrefs.toggles } });
    persist(get());
  },

  focusedIndex: 0,
  setFocusedIndex: (focusedIndex) => set({ focusedIndex }),
  selectedId: null,
  setSelectedId: (selectedId) => set({ selectedId }),

  marked: [],
  anchorIndex: null,
  setMarked: (marked) => set({ marked }),
  setAnchorIndex: (anchorIndex) => set({ anchorIndex }),
  toggleMarked: (id, index) =>
    set((s) => ({
      marked: s.marked.includes(id) ? s.marked.filter((m) => m !== id) : [...s.marked, id],
      anchorIndex: index,
    })),
  // Merging without touching the anchor is what lets a second shift+click
  // widen or re-aim the range from the same origin.
  markRange: (ids) =>
    set((s) => {
      const merged = new Set(s.marked);
      for (const id of ids) merged.add(id);
      return { marked: [...merged] };
    }),
  clearMarked: () => set({ marked: [], anchorIndex: null }),

  theme: getTheme(),
  setThemeChoice: (theme) => {
    setTheme(theme);
    set({ theme });
  },

  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  lightboxIndex: null,
  setLightboxIndex: (lightboxIndex) => set({ lightboxIndex }),

  commands: [],
  setCommands: (commands) => set({ commands }),

  undoStack: [],
  pushUndo: (e) =>
    set((s) => ({
      undoStack: [
        { ...e, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() },
        ...s.undoStack,
      ].slice(0, 10),
    })),
  popUndo: () => {
    const [top, ...rest] = get().undoStack;
    if (!top) return null;
    set({ undoStack: rest });
    return top;
  },
}));

/** Any overlay that owns the keyboard suppresses the screen-level hotkeys. */
export function useOverlayOpen(): boolean {
  return useUi((s) => s.paletteOpen || s.shortcutsOpen || s.lightboxIndex !== null);
}
