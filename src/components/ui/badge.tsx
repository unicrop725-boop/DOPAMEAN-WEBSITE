import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/** Small status pill. Colour is never the only signal: the text always says the state. */
const badgeVariants = cva(
  'inline-flex items-center border px-1.5 py-0.5 font-mono text-xs uppercase leading-none tracking-wide whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line-strong bg-paper text-ink',
        success: 'border-success-text bg-success-bg text-success-text',
        warning: 'border-warning-text bg-warning-bg text-warning-text',
        danger: 'border-danger bg-danger-bg text-danger',
        muted: 'border-line bg-panel-alt text-muted-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
