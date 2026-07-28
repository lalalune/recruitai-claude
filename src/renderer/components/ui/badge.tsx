import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border bg-transparent text-muted-foreground',
        green: 'border-transparent bg-ok/18 text-ok',
        amber: 'border-transparent bg-warn/20 text-warn',
        red: 'border-transparent bg-destructive/18 text-destructive',
        blue: 'border-transparent bg-info/18 text-info',
        solid: 'border-transparent bg-primary text-primary-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

export function Badge({ className, variant, asChild, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
