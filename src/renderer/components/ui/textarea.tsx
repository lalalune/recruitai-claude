import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils.js';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-relaxed transition-[color,box-shadow] outline-none',
        'placeholder:text-muted-foreground/70',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'field-sizing-content resize-y',
        className,
      )}
      {...props}
    />
  );
}
