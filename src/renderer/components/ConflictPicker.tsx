import { Check } from 'lucide-react';
import { useState } from 'react';

import type { ResolvedField } from '../../shared/ipc.js';
import { dateTime, fieldLabel, sourceLabel } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';

export interface ConflictPickerProps {
  provenance: ResolvedField;
  onPick: (observationId: number) => void;
  onCancel?: () => void;
}

/**
 * Sources disagree constantly — a careers page says 40 people, LinkedIn says
 * 180. Picking a winner is recorded as a human observation rather than an edit,
 * so the losing values stay on the record and the choice itself is evidence.
 */
export function ConflictPicker({ provenance, onPick, onCancel }: ConflictPickerProps) {
  const candidates = dedupe(provenance.observations);
  const initial =
    candidates.find((o) => o.value === provenance.value && o.source === provenance.source)?.id ??
    candidates[0]?.id ??
    null;
  const [picked, setPicked] = useState<number | null>(initial);

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[11px] font-semibold">
          Sources disagree on {fieldLabel(provenance.field).toLowerCase()}
        </div>
        <div className="text-[10px] text-muted-foreground">
          Choosing one records it as your observation. Nothing is deleted.
        </div>
      </div>

      <div role="radiogroup" className="max-h-64 overflow-y-auto py-1">
        {candidates.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={picked === o.id}
            onClick={() => setPicked(o.id)}
            className={cn(
              'flex w-full items-start gap-2 px-3 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
              picked === o.id && 'bg-primary/10',
            )}
          >
            <span
              className={cn(
                'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                picked === o.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
              )}
            >
              {picked === o.id && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span data-selectable className="truncate font-mono text-[11px]">
                {o.value ?? <span className="text-muted-foreground italic">empty</span>}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {sourceLabel(o.source)} · {o.confidence} · {dateTime(o.observedAt)}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
        {onCancel && (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="xs" disabled={picked == null} onClick={() => picked != null && onPick(picked)}>
          Use this value
        </Button>
      </div>
    </div>
  );
}

/** Two sources reporting the same string are one candidate, not two. */
function dedupe(obs: ResolvedField['observations']): ResolvedField['observations'] {
  const seen = new Map<string, ResolvedField['observations'][number]>();
  for (const o of [...obs].sort((a, b) => b.observedAt - a.observedAt)) {
    const key = `${o.value ?? ''}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, o);
  }
  return [...seen.values()];
}
