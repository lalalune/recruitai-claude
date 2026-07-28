import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { cn, readJson, writeJson } from '../lib/utils.js';

export interface SectionProps {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  /** Overrides the persistence key, which defaults to the title. */
  storageKey?: string;
  className?: string;
  bodyClassName?: string;
}

export function Section({
  title,
  count,
  defaultOpen = true,
  actions,
  children,
  storageKey,
  className,
  bodyClassName,
}: SectionProps) {
  const key = `recruitai.section.${storageKey ?? title}`;
  const [open, setOpen] = useState(() => readJson<boolean>(key, defaultOpen));

  const toggle = () => {
    setOpen((o) => {
      writeJson(key, !o);
      return !o;
    });
  };

  return (
    <section className={cn('border-b border-border', className)}>
      <div className="flex h-8 items-center gap-1.5 px-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="-ml-1 flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          <span className="text-[10px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
            {title}
          </span>
          {count != null && (
            <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
              {count}
            </span>
          )}
        </button>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {open && <div className={cn('px-3 pt-0.5 pb-3', bodyClassName)}>{children}</div>}
    </section>
  );
}
