import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { Money, formatRupees } from '@/modules/pricing';

/** Plain text for an amount of paise, e.g. "Rs. 1,499". Money stays integer paise everywhere else. */
export const rupeesText = (paise: number) => `Rs. ${formatRupees(Money.of(paise))}`;

export function Rupees({ paise, className }: { paise: number; className?: string }) {
  return (
    <span className={cn('font-mono tabular-nums whitespace-nowrap', className)}>
      {rupeesText(paise)}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  id = 'page-title',
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  id?: string;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 id={id} className="font-mono text-lg uppercase">
          {title}
        </h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-text">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p
      role="status"
      className="mb-4 border border-success-text bg-success-bg p-3 text-sm text-success-text"
    >
      {text}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="border border-dashed border-line-strong bg-paper p-8 text-center">
      <p className="font-mono text-sm uppercase">{title}</p>
      {children && <div className="mt-2 text-sm text-muted-text">{children}</div>}
    </div>
  );
}

/** Shown when a signed-in person opens a page their role may not use (the server already refused the data). */
export function Forbidden({
  what,
  reason = 'FORBIDDEN',
}: {
  what: string;
  reason?: 'FORBIDDEN' | 'TWO_FACTOR_REQUIRED';
}) {
  return (
    <section
      role="alert"
      aria-labelledby="forbidden-title"
      className="border border-danger bg-danger-bg p-6"
    >
      <h1 id="forbidden-title" className="font-mono text-lg uppercase">
        403 · Not allowed
      </h1>
      <p className="mt-2 text-sm">
        {reason === 'TWO_FACTOR_REQUIRED'
          ? 'Two-factor authentication is required before you can use this page.'
          : `Your role does not have access to ${what}. Ask an owner if you need it.`}
      </p>
      <p className="mt-4">
        <Link href="/admin" className="admin-link text-sm">
          Back to the dashboard
        </Link>
      </p>
    </section>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'muted';

const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};
const FULFILLMENT: Record<string, { label: string; tone: Tone }> = {
  unfulfilled: { label: 'Unfulfilled', tone: 'warning' },
  shipped: { label: 'Shipped', tone: 'neutral' },
  delivered: { label: 'Delivered', tone: 'success' },
};
const PAYMENT: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  captured: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  partially_refunded: { label: 'Part refunded', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'muted' },
  needs_review: { label: 'Needs review', tone: 'danger' },
};
const PRODUCT: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'warning' },
  published: { label: 'Published', tone: 'success' },
  archived: { label: 'Archived', tone: 'muted' },
};

function pill(map: Record<string, { label: string; tone: Tone }>, key: string | null) {
  if (!key) return <Badge tone="muted">None</Badge>;
  const m = map[key] ?? { label: key, tone: 'neutral' as Tone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
export const OrderStatusBadge = ({ status }: { status: string }) => pill(ORDER_STATUS, status);
export const FulfillmentBadge = ({ status }: { status: string }) => pill(FULFILLMENT, status);
export const PaymentBadge = ({ status }: { status: string | null }) => pill(PAYMENT, status);
export const ProductStatusBadge = ({ status }: { status: string }) => pill(PRODUCT, status);
export const orderStatusLabel = (s: string) => ORDER_STATUS[s]?.label ?? s;

/** Previous / next links that keep the current filters in the URL. */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  hrefFor: (page: number) => string;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const linkClass =
    'border border-line-strong bg-paper px-3 py-1.5 font-mono text-xs uppercase hover:bg-panel';
  const off = 'border border-line px-3 py-1.5 font-mono text-xs uppercase text-muted-text';
  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-text">
        {total === 0 ? 'No results' : `Showing ${from}-${to} of ${total}`} · page {page} of{' '}
        {pageCount}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className={linkClass} rel="prev">
            Previous
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            Previous
          </span>
        )}
        {page < pageCount ? (
          <Link href={hrefFor(page + 1)} className={linkClass} rel="next">
            Next
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

/**
 * One metric with its written definition on the page (brief: every metric has a one-line definition).
 * The definition sits inside the term so each tile is a single term/value pair.
 */
export function Metric({
  label,
  value,
  definition,
  href,
}: {
  label: string;
  value: React.ReactNode;
  definition: string;
  href?: string;
}) {
  return (
    <div className="bg-paper p-4">
      <dt>
        <span className="font-mono text-xs uppercase text-muted-text">
          {href ? (
            <Link href={href} className="admin-link">
              {label}
            </Link>
          ) : (
            label
          )}
        </span>
        <span className="mt-1 block text-xs text-muted-text">{definition}</span>
      </dt>
      <dd className="mt-2 font-mono text-2xl tabular-nums">{value}</dd>
    </div>
  );
}

export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function dateOnly(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
