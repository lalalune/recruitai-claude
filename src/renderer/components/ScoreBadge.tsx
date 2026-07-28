import type { ScoreComponent } from '../../shared/score.js';
import { cn, scoreColor } from '../lib/utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';

export interface ScoreBadgeProps {
  score: number | null;
  breakdown?: ScoreComponent[];
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  sm: 'h-5 min-w-5 rounded text-[10px] font-semibold',
  md: 'h-6 min-w-6 rounded-md text-[12px] font-semibold',
  lg: 'h-8 min-w-8 rounded-lg text-[15px] font-bold',
} as const;

export function ScoreBadge({ score, breakdown, size = 'sm', className }: ScoreBadgeProps) {
  const { bg, fg } = scoreColor(score);
  const badge = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center px-1 tabular-nums',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: bg, color: fg }}
      aria-label={score == null ? 'Not scored' : `Quality score ${score} of 10`}
    >
      {score == null ? '–' : score}
    </span>
  );

  if (!breakdown || breakdown.length === 0) return badge;

  const total = breakdown.reduce((s, c) => s + c.points, 0);
  const max = breakdown.reduce((s, c) => s + c.max, 0);

  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="w-[300px] p-0">
        <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
          <span className="text-[11px] font-semibold">Score breakdown</span>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {Math.round(total)} / {max}
          </span>
        </div>
        <ul className="flex flex-col gap-1.5 p-2.5">
          {breakdown.map((c) => (
            <li key={c.key} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium">{c.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {Math.round(c.points)}/{c.max}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(0, Math.min(100, (c.points / c.max) * 100))}%` }}
                />
              </div>
              {c.reason && (
                <span className="text-[10px] leading-snug text-muted-foreground">{c.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
