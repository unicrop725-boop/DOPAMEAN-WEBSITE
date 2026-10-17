import * as React from 'react';
import { cn } from '@/lib/cn';

/** Native select (keyboard and screen-reader behaviour for free), styled like the other inputs. */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-9 w-full border border-muted-text bg-paper px-2 text-sm focus-visible:border-ink disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';
