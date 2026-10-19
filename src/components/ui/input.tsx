import * as React from 'react';
import { cn } from '@/lib/cn';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'h-9 w-full border border-line-strong bg-paper px-3 text-sm placeholder:text-muted focus-visible:border-ink disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
