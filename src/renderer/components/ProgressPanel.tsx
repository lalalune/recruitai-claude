import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Pause } from 'lucide-react';
import type { LogLine, SourceStatus } from '../../shared/ipc.js';
import { Button } from './ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';
import { cn } from '../lib/utils.js';

const MAX_LINES = 200;

export function ProgressBar({
  done,
  total,
  indeterminate = false,
  className,
}: {
  done: number;
  total: number;
  indeterminate?: boolean;
  className?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      {indeterminate || total <= 0 ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

export function SpendMeter({
  provider,
  spentUsd,
  capUsd,
}: {
  provider: string;
  spentUsd: number;
  capUsd: number;
}) {
  const pct = capUsd > 0 ? Math.min(100, (spentUsd / capUsd) * 100) : 0;
  const hot = pct >= 90;
  const warm = pct >= 70;
  return (
    <div className="min-w-40 flex-1">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium">{provider}</span>
        <span className={cn('tabular-nums', hot ? 'text-destructive' : 'text-muted-foreground')}>
          ${spentUsd.toFixed(2)} / ${capUsd.toFixed(2)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            hot ? 'bg-destructive' : warm ? 'bg-amber-500' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export interface ProgressPanelProps {
  log: LogLine[];
  sources: SourceStatus[];
  spend: { provider: string; spentUsd: number; capUsd: number }[];
  className?: string;
}

export function ProgressPanel({ log, sources, spend, className }: ProgressPanelProps) {
  const [filter, setFilter] = useState<string>('all');
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement | null>(null);

  const known = new Set(sources.map((s) => s.key as string));
  for (const line of log) known.add(line.source);
  const sourceOptions = [...known].sort();

  const lines = (filter === 'all' ? log : log.filter((l) => l.source === filter)).slice(-MAX_LINES);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines.length, follow, filter]);

  // Scrolling up is a deliberate act of reading; the tail must not yank the view
  // back down until the operator returns to the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const jump = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  };

  return (
    <div className={cn('flex min-h-0 flex-col rounded-lg border border-border bg-card', className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Log</span>
        <span className="text-xs text-muted-foreground">
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!follow && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={jump}>
              <Pause className="h-3 w-3" />
              Paused
              <ArrowDownToLine className="h-3 w-3" />
            </Button>
          )}
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {sourceOptions.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
        {lines.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground">Nothing logged yet.</div>
        ) : (
          lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-muted-foreground/70">{clock(l.at)}</span>
              <span className="w-32 shrink-0 truncate text-muted-foreground">{l.source}</span>
              <span
                className={cn(
                  'min-w-0 flex-1',
                  l.level === 'error' && 'text-destructive',
                  l.level === 'warn' && 'text-amber-600 dark:text-amber-400',
                )}
              >
                {l.message}
              </span>
            </div>
          ))
        )}
      </div>

      {spend.length > 0 && (
        <div className="flex flex-wrap gap-4 border-t border-border px-3 py-2.5">
          {spend.map((s) => (
            <SpendMeter key={s.provider} {...s} />
          ))}
        </div>
      )}
    </div>
  );
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

export default ProgressPanel;
