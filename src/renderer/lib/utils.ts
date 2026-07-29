import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme. Dark by default, follows OS, no theme library.
// ─────────────────────────────────────────────────────────────────────────────

export type Theme = 'system' | 'dark' | 'light';

const THEME_KEY = 'recruitai.theme';

export function getTheme(): Theme {
  const v = safeLocalGet(THEME_KEY);
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
}

export function applyTheme(theme: Theme = getTheme()): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  document.getElementById('boot-bg')?.remove();
}

export function setTheme(theme: Theme): void {
  safeLocalSet(THEME_KEY, theme);
  applyTheme(theme);
}

/** Call once at mount; keeps `system` in sync when the OS flips appearance. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getTheme() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

// ─────────────────────────────────────────────────────────────────────────────
// Score ramp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Viridis-like ordering rather than a red→green ramp, which is the one scale a
 * deuteranope cannot read — and score is the single most important glyph in the
 * whole UI. Light foreground on the dark end, dark foreground on the bright end.
 */
export function scoreColor(score: number | null | undefined): { bg: string; fg: string } {
  if (score == null || !Number.isFinite(score)) {
    return { bg: 'var(--score-0)', fg: 'oklch(0.99 0 0)' };
  }
  const n = Math.max(1, Math.min(10, Math.round(score)));
  return {
    bg: `var(--score-${n})`,
    fg: n >= 7 ? 'oklch(0.18 0.02 260)' : 'oklch(0.99 0.005 260)',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export const MOD = isMac ? '⌘' : 'Ctrl';

// ─────────────────────────────────────────────────────────────────────────────
// Event-target classification for the screen-level hotkeys
//
// Both walk the ancestor chain by hand rather than calling `Element.closest`,
// which keeps them pure enough to unit-test against a plain object chain under
// node — there is no DOM in the test runner.
// ─────────────────────────────────────────────────────────────────────────────

export interface ElementLike {
  tagName?: string;
  getAttribute?(name: string): string | null;
  parentElement?: ElementLike | null;
}

const ACTIVATION_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const ACTIVATION_ROLES = new Set([
  'button',
  'switch',
  'checkbox',
  'combobox',
  'menuitem',
  'radio',
  'tab',
  'link',
]);

function* ancestors(target: unknown): Generator<ElementLike> {
  for (let el = target as ElementLike | null | undefined; el; el = el.parentElement) yield el;
}

/**
 * True when the event originated on something the browser activates with the
 * space bar. The `space` hotkey must not `preventDefault` over those, or a
 * focused button can never be pressed from the keyboard.
 */
export function isActivationTarget(target: unknown): boolean {
  for (const el of ancestors(target)) {
    if (el.tagName && ACTIVATION_TAGS.has(el.tagName.toUpperCase())) return true;
    const role = el.getAttribute?.('role');
    if (role && ACTIVATION_ROLES.has(role)) return true;
  }
  return false;
}

/**
 * True inside a Radix popover/dropdown/dialog layer. Those own the keyboard
 * while they are open, so a screen hotkey (`a` approves, `x` rejects) must not
 * also fire at the record behind them.
 */
export function isInOverlayLayer(target: unknown): boolean {
  for (const el of ancestors(target)) {
    if (el.getAttribute?.('data-radix-popper-content-wrapper') != null) return true;
    const role = el.getAttribute?.('role');
    if (role === 'dialog' || role === 'alertdialog') return true;
  }
  return false;
}

export function safeLocalGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeLocalSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — persistence is a nicety, never a requirement */
  }
}

export function safeLocalRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* same rationale as safeLocalSet */
  }
}

/**
 * Set once the operator genuinely leaves the setup wizard (finish, skip, or
 * navigating away) — never on arrival. App checks it on launch; Setup writes it
 * on finish; App also writes it on a real transition away from the screen.
 */
export const SETUP_COMPLETE_KEY = 'recruitai.setupComplete';

export function readJson<T>(key: string, fallback: T): T {
  const raw = safeLocalGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  safeLocalSet(key, JSON.stringify(value));
}
