'use client';

import { Button } from '@/components/ui/button';

/** Error boundary for admin pages: no stack trace or message is shown, only a digest to quote in a bug report. */
export default function PanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section role="alert" className="border border-danger bg-danger-bg p-6">
      <h1 className="font-mono text-lg uppercase">Something went wrong</h1>
      <p className="mt-2 text-sm">
        This page could not be loaded. Nothing was changed. Try again, and if it keeps happening
        tell whoever runs the site{error.digest ? ` (reference ${error.digest})` : ''}.
      </p>
      <div className="mt-4">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
      </div>
    </section>
  );
}
