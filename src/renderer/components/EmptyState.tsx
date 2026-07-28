import { isValidElement, type ReactNode } from 'react';

import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Either a rendered control, or `{label, onClick}` for the common case. */
  action?: ReactNode | EmptyStateAction;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-2 px-8 py-12 text-center',
        className,
      )}
    >
      {icon && <div className="mb-1 text-muted-foreground/50 [&_svg]:size-7">{icon}</div>}
      <div className="text-[13px] font-medium">{title}</div>
      {description && (
        <div className="max-w-xs text-xs leading-relaxed text-balance text-muted-foreground">
          {description}
        </div>
      )}
      {action != null && <div className="mt-2">{renderAction(action)}</div>}
    </div>
  );
}

function renderAction(action: ReactNode | EmptyStateAction): ReactNode {
  if (isActionSpec(action)) {
    return (
      <Button size="sm" variant="outline" onClick={action.onClick}>
        {action.label}
      </Button>
    );
  }
  return action as ReactNode;
}

function isActionSpec(a: unknown): a is EmptyStateAction {
  return (
    typeof a === 'object' &&
    a !== null &&
    !isValidElement(a) &&
    typeof (a as EmptyStateAction).label === 'string' &&
    typeof (a as EmptyStateAction).onClick === 'function'
  );
}
