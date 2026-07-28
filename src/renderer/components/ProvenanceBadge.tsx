import { Info } from 'lucide-react';

import type { ResolvedField } from '../../shared/ipc.js';
import { ago, dateTime, fieldLabel, sourceLabel } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';

const CONFIDENCE_COLOR: Record<string, string> = {
  high: 'bg-ok',
  medium: 'bg-warn',
  low: 'bg-destructive',
};

export interface ProvenanceBadgeProps {
  provenance: ResolvedField;
  className?: string;
}

/**
 * Every sourced value carries where it came from. This is a core primitive
 * rather than a debug view: the operator's whole job is deciding whether to
 * trust a record, and an unattributed number is not evidence.
 */
export function ProvenanceBadge({ provenance, className }: ProvenanceBadgeProps) {
  const history = [...provenance.observations].sort((a, b) => b.observedAt - a.observedAt);
  const latest = history[0];

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        aria-label={`Provenance for ${fieldLabel(provenance.field)}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Info className="size-3" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border px-3 py-2">
          <div className="text-[11px] font-semibold">{fieldLabel(provenance.field)}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                'size-1.5 rounded-full',
                CONFIDENCE_COLOR[provenance.confidence] ?? 'bg-muted-foreground',
              )}
              title={`${provenance.confidence} confidence`}
            />
            <span>{sourceLabel(provenance.source)}</span>
            {latest && <span>· {ago(latest.observedAt)}</span>}
          </div>
        </div>

        <ul className="max-h-64 overflow-y-auto py-1">
          {history.length === 0 && (
            <li className="px-3 py-2 text-[11px] text-muted-foreground">No recorded history.</li>
          )}
          {history.map((o) => {
            const winning = o.value === provenance.value && o.source === provenance.source;
            return (
              <li
                key={o.id}
                className={cn('flex flex-col gap-0.5 px-3 py-1.5', winning && 'bg-primary/8')}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    data-selectable
                    className="truncate font-mono text-[11px]"
                    title={o.value ?? '—'}
                  >
                    {o.value ?? <span className="text-muted-foreground italic">empty</span>}
                  </span>
                  {winning && (
                    <span className="shrink-0 text-[9px] font-semibold tracking-wide text-primary uppercase">
                      current
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span
                    className={cn(
                      'size-1 rounded-full',
                      CONFIDENCE_COLOR[o.confidence] ?? 'bg-muted-foreground',
                    )}
                  />
                  <span>{sourceLabel(o.source)}</span>
                  <span>· {dateTime(o.observedAt)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
