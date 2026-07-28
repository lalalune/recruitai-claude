import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { clamp, cn, readJson, writeJson } from '../lib/utils.js';

export interface SplitViewProps {
  left: ReactNode;
  right: ReactNode;
  /** Width is persisted per call site so Review and each Outreach tab differ. */
  storageKey: string;
  minLeft?: number;
  maxLeft?: number;
  defaultLeft?: number;
  className?: string;
}

export function SplitView({
  left,
  right,
  storageKey,
  minLeft = 260,
  maxLeft = 720,
  defaultLeft = 380,
  className,
}: SplitViewProps) {
  const key = `recruitai.split.${storageKey}`;
  const [width, setWidth] = useState(() => clamp(readJson(key, defaultLeft), minLeft, maxLeft));
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    writeJson(key, width);
  }, [key, width]);

  const applyFromClientX = useCallback(
    (clientX: number) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setWidth(clamp(clientX - rect.left, minLeft, Math.min(maxLeft, rect.width - 320)));
    },
    [minLeft, maxLeft],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    applyFromClientX(e.clientX);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setWidth((w) => clamp(w - step, minLeft, maxLeft));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth((w) => clamp(w + step, minLeft, maxLeft));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(defaultLeft);
    }
  };

  return (
    <div ref={rootRef} className={cn('flex h-full min-h-0 w-full', className)}>
      <div className="flex h-full min-h-0 shrink-0 flex-col" style={{ width }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={width}
        aria-valuemin={minLeft}
        aria-valuemax={maxLeft}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setWidth(defaultLeft)}
        onKeyDown={onKeyDown}
        className={cn(
          'relative z-10 w-px shrink-0 cursor-col-resize bg-border transition-colors',
          'after:absolute after:inset-y-0 after:-left-1.5 after:w-3.5 after:content-[""]',
          'hover:bg-primary focus-visible:bg-primary',
          dragging && 'bg-primary',
        )}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">{right}</div>
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
