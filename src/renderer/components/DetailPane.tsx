import type { ReactNode } from 'react';

import { cn } from '../lib/utils.js';

export interface DetailPaneProps {
  children: ReactNode;
  className?: string;
}

/**
 * The scroll container for the right half of every SplitView. `data-detail-pane`
 * is the anchor the tab/shift-tab field traversal searches within.
 */
export function DetailPane({ children, className }: DetailPaneProps) {
  return (
    <div
      data-detail-pane
      className={cn('min-h-0 flex-1 overflow-x-hidden overflow-y-auto', className)}
    >
      {children}
    </div>
  );
}
