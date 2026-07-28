import type { MouseEvent, ReactNode } from 'react';

import { cn } from '../lib/utils.js';
import { ScoreBadge } from './ScoreBadge.js';
import { StatusChip, type ChipTone } from './StatusChip.js';

export interface RowChip {
  label: string;
  tone?: ChipTone;
  title?: string;
}

export interface ListRowProps {
  score?: number | null;
  title: string;
  subtitle?: string;
  chips?: RowChip[];
  selected?: boolean;
  focused?: boolean;
  onClick?: (e?: MouseEvent<HTMLDivElement>) => void;
  /** Multi-select marker rendered as a left edge bar; keeps rows one line tall. */
  marked?: boolean;
  trailing?: ReactNode;
  dimmed?: boolean;
  className?: string;
}

export function ListRow({
  score,
  title,
  subtitle,
  chips,
  selected,
  focused,
  onClick,
  marked,
  trailing,
  dimmed,
  className,
}: ListRowProps) {
  return (
    <div
      role="option"
      aria-selected={!!selected}
      onClick={onClick}
      className={cn(
        'group relative grid h-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/45 px-2.5',
        'transition-colors',
        selected ? 'bg-primary/12' : 'hover:bg-accent/55',
        dimmed && 'opacity-55',
        className,
      )}
    >
      {/* The focus ring is painted from state: virtualized rows unmount, so real
          DOM focus cannot survive a scroll. */}
      {focused && (
        <span className="pointer-events-none absolute inset-0 rounded-[3px] ring-2 ring-ring ring-inset" />
      )}
      {marked && <span className="absolute inset-y-0 left-0 w-[3px] bg-primary" />}

      <ScoreBadge score={score ?? null} />

      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] leading-tight font-medium">{title}</span>
        {subtitle && (
          <span className="truncate text-[11px] leading-tight text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {chips?.map((c) => (
          <StatusChip key={c.label} label={c.label} tone={c.tone} title={c.title} />
        ))}
        {trailing}
      </div>
    </div>
  );
}
