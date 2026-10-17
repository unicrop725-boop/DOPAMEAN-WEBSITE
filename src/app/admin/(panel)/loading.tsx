/** Shown while a server-rendered admin page loads (route-level Suspense fallback). */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="mb-4 h-6 w-48 animate-pulse bg-line" aria-hidden="true" />
      <div className="grid gap-px border border-line bg-line md:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse bg-paper" />
        ))}
      </div>
      <div className="mt-4 h-64 animate-pulse bg-paper" aria-hidden="true" />
    </div>
  );
}
