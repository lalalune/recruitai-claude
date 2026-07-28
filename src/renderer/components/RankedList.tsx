import { useVirtualizer } from '@tanstack/react-virtual';
import { useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';

import { cn } from '../lib/utils.js';

export interface RowMods {
  shift: boolean;
  meta: boolean;
}

export interface RankedListHandle {
  scrollToIndex: (index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }) => void;
  measure: () => void;
}

export interface RankedListProps<T extends { id: string }> {
  items: T[];
  selectedId?: string | null;
  focusedIndex?: number;
  onFocus?: (index: number) => void;
  onSelect?: (id: string, index: number, mods?: RowMods) => void;
  renderRow: (item: T, index: number, state: { selected: boolean; focused: boolean }) => ReactNode;
  estimateSize?: number;
  emptyState?: ReactNode;
  className?: string;
  ref?: Ref<RankedListHandle>;
}

/**
 * TanStack Table has no virtualization of its own, so this pairs the virtualizer
 * directly with absolutely-positioned divs. A real <table> is deliberately not
 * used: transform-positioned rows inside table layout collapse.
 */
export function RankedList<T extends { id: string }>({
  items,
  selectedId,
  focusedIndex = -1,
  onFocus,
  onSelect,
  renderRow,
  estimateSize = 46,
  emptyState,
  className,
  ref,
}: RankedListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 14,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, opts) =>
        virtualizer.scrollToIndex(index, { align: opts?.align ?? 'auto' }),
      measure: () => virtualizer.measure(),
    }),
    [virtualizer],
  );

  if (items.length === 0) {
    return <div className={cn('min-h-0 flex-1 overflow-hidden', className)}>{emptyState}</div>;
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Ranked records"
      tabIndex={-1}
      className={cn('min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none', className)}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((v) => {
          const item = items[v.index];
          if (!item) return null;
          return (
            <div
              key={v.key}
              data-index={v.index}
              className="absolute top-0 left-0 w-full"
              style={{ height: v.size, transform: `translateY(${v.start}px)` }}
              onMouseDown={() => onFocus?.(v.index)}
              onClick={(e) => {
                onSelect?.(item.id, v.index, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
              }}
            >
              {renderRow(item, v.index, {
                selected: selectedId === item.id,
                focused: focusedIndex === v.index,
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
