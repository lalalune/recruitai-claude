import { create } from 'zustand';

import type { CompanyFilter } from '../../shared/ipc.js';
import { readJson, writeJson } from '../lib/utils.js';

export type Screen = 'review' | 'outreach' | 'pipeline' | 'settings' | 'setup';

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

  /**
   * The focused row is state, not DOM focus: virtualized rows unmount as they
   * scroll out, taking any real focus with them.
   */
  focusedIndex: number;
  setFocusedIndex: (i: number) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;

  /** Multi-select for bulk actions. Anchor supports shift+click ranges. */
  marked: string[];
  anchorIndex: number | null;
  setMarked: (ids: string[]) => void;
  toggleMarked: (id: string, index: number) => void;
  markRange: (ids: string[], index: number) => void;
  clearMarked: () => void;

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

  focusedIndex: 0,
  setFocusedIndex: (focusedIndex) => set({ focusedIndex }),
  selectedId: null,
  setSelectedId: (selectedId) => set({ selectedId }),

  marked: [],
  anchorIndex: null,
  setMarked: (marked) => set({ marked }),
  toggleMarked: (id, index) =>
    set((s) => ({
      marked: s.marked.includes(id) ? s.marked.filter((m) => m !== id) : [...s.marked, id],
      anchorIndex: index,
    })),
  markRange: (ids, index) =>
    set((s) => {
      const merged = new Set(s.marked);
      for (const id of ids) merged.add(id);
      return { marked: [...merged], anchorIndex: index };
    }),
  clearMarked: () => set({ marked: [], anchorIndex: null }),

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
