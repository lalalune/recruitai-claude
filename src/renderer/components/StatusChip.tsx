import type { ReactNode } from 'react';

import { Badge } from './ui/badge.js';
import { cn } from '../lib/utils.js';

/**
 * `default | green | amber | red | blue` is the canonical vocabulary. The
 * semantic aliases are accepted too so call sites can say what a colour *means*
 * instead of what it looks like.
 */
export type ChipTone =
  | 'default'
  | 'green'
  | 'amber'
  | 'red'
  | 'blue'
  | 'good'
  | 'warn'
  | 'bad'
  | 'info'
  | 'neutral'
  | 'muted';

type CanonicalTone = 'default' | 'green' | 'amber' | 'red' | 'blue' | 'outline';

const TONE_MAP: Record<ChipTone, CanonicalTone> = {
  default: 'default',
  neutral: 'default',
  muted: 'outline',
  green: 'green',
  good: 'green',
  amber: 'amber',
  warn: 'amber',
  red: 'red',
  bad: 'red',
  blue: 'blue',
  info: 'blue',
};

export interface StatusChipProps {
  label: string;
  tone?: ChipTone;
  icon?: ReactNode;
  title?: string;
  className?: string;
  onClick?: () => void;
}

export function StatusChip({
  label,
  tone = 'default',
  icon,
  title,
  className,
  onClick,
}: StatusChipProps) {
  return (
    <Badge
      variant={TONE_MAP[tone] ?? 'default'}
      title={title ?? label}
      onClick={onClick}
      className={cn(onClick && 'cursor-pointer hover:brightness-125', className)}
    >
      {icon}
      {label}
    </Badge>
  );
}
