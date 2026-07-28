import type { ReactNode } from 'react';

import { Button, type ButtonProps } from './ui/button.js';
import { cn } from '../lib/utils.js';

export interface Action {
  /** Stable identity; when it is a single character it doubles as the key hint. */
  key?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'destructive';
  /** Explicit keyboard hint when it differs from `key` (e.g. `⌘↵`). */
  hint?: string;
  variant?: ButtonProps['variant'];
  icon?: ReactNode;
}

export interface ActionBarProps {
  actions: Action[];
  trailing?: ReactNode;
  className?: string;
}

/**
 * The keyboard hint is rendered inside the button rather than in a tooltip: the
 * whole point of the review loop is that the operator stops using the mouse, and
 * a hint you have to hover to see never teaches anyone anything.
 */
export function ActionBar({ actions, trailing, className }: ActionBarProps) {
  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center gap-1 border-t border-border bg-surface-2 px-2',
        className,
      )}
    >
      {actions.map((a) => {
        const hint = a.hint ?? a.key;
        return (
          <Button
            key={a.key ?? a.label}
            size="sm"
            variant={a.variant ?? 'ghost'}
            disabled={a.disabled}
            onClick={a.onClick}
            className={cn(
              'gap-1.5 px-2',
              a.tone === 'destructive' &&
                'text-destructive hover:bg-destructive/12 hover:text-destructive',
            )}
          >
            {a.icon}
            <span>{a.label}</span>
            {hint && <kbd className="kbd ml-0.5">{hint}</kbd>}
          </Button>
        );
      })}
      <div className="ml-auto flex items-center gap-2">{trailing}</div>
    </div>
  );
}
