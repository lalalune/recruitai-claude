import { ChevronLeft, ChevronRight, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { useEffect } from 'react';

import type { ScreenshotRow } from '../../shared/ipc.js';
import { openExternal, useScreenshot } from '../lib/api.js';
import { dateTime, titleCase } from '../lib/format.js';
import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';

export interface EvidenceThumbProps {
  shot: ScreenshotRow;
  onClick?: () => void;
  className?: string;
}

export function EvidenceThumb({ shot, onClick, className }: EvidenceThumbProps) {
  const { data, isLoading } = useScreenshot(shot.relPath);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${titleCase(shot.kind)} · ${dateTime(shot.capturedAt)}`}
      className={cn(
        'group relative aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-surface-3 outline-none transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {data ? (
        <img
          src={data}
          alt={`${shot.kind} screenshot`}
          className="size-full object-cover object-top transition-transform group-hover:scale-[1.02]"
          loading="lazy"
        />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground/50">
          <ImageIcon className={cn('size-5', isLoading && 'animate-pulse')} />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-4 pb-1 text-left text-[10px] text-white">
        {titleCase(shot.kind)}
      </span>
    </button>
  );
}

export interface EvidenceViewerProps {
  shots: ScreenshotRow[];
  /** null closes the lightbox; otherwise the index being shown. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
}

export function EvidenceViewer({ shots, index, onIndexChange }: EvidenceViewerProps) {
  const open = index != null && index >= 0 && index < shots.length;
  const shot = open ? shots[index] : null;
  const { data } = useScreenshot(shot?.relPath ?? null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault();
        onIndexChange(Math.min(shots.length - 1, (index as number) + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        onIndexChange(Math.max(0, (index as number) - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, shots.length, onIndexChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onIndexChange(null)}>
      <DialogContent
        className="flex h-[86vh] max-w-[min(1180px,92vw)] flex-col overflow-hidden p-0"
        showClose={false}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <DialogTitle className="truncate text-[12px]">
            {shot ? titleCase(shot.kind) : 'Evidence'}
          </DialogTitle>
          {shot && (
            <span className="truncate text-[11px] text-muted-foreground">
              {dateTime(shot.capturedAt)}
              {shot.width && shot.height ? ` · ${shot.width}×${shot.height}` : ''}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {shot?.url && (
              <Button size="xs" variant="ghost" onClick={() => openExternal(shot.url as string)}>
                <ExternalLink />
                Open source
              </Button>
            )}
            <span className="px-1 font-mono text-[11px] text-muted-foreground tabular-nums">
              {open ? (index as number) + 1 : 0}/{shots.length}
            </span>
            <Button size="xs" variant="ghost" onClick={() => onIndexChange(null)}>
              Close
              <kbd className="kbd">esc</kbd>
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div className="size-full overflow-auto bg-surface-3">
            {data ? (
              <img src={data} alt="Captured evidence" className="w-full" />
            ) : (
              <div className="flex size-full items-center justify-center text-[12px] text-muted-foreground">
                {shot ? 'Loading screenshot…' : 'No screenshot selected'}
              </div>
            )}
          </div>

          {shots.length > 1 && (
            <>
              <NavButton
                side="left"
                disabled={index === 0}
                onClick={() => onIndexChange(Math.max(0, (index ?? 0) - 1))}
              />
              <NavButton
                side="right"
                disabled={index === shots.length - 1}
                onClick={() => onIndexChange(Math.min(shots.length - 1, (index ?? 0) + 1))}
              />
            </>
          )}
        </div>

        {shot?.url && (
          <div
            data-selectable
            className="shrink-0 truncate border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
          >
            {shot.url}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: 'left' | 'right';
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous evidence' : 'Next evidence'}
      className={cn(
        'absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-popover/90 text-foreground shadow-lg outline-none transition-opacity hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        side === 'left' ? 'left-2' : 'right-2',
        disabled && 'pointer-events-none opacity-30',
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
