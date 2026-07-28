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
