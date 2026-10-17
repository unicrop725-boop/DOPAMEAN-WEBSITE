import Link from 'next/link';
import { getDb } from '@/db/client';
import { ActionButton } from '@/components/admin/confirm-action';
import { FilterBar, FilterInput } from '@/components/admin/filter-bar';
import { EmptyState, Forbidden, PageHeader, Pagination, dateTime } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { listContactMessagesAdmin, listNewsletterSubscribersAdmin } from '@/lib/admin/messages';
import { enumParam, first, gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { cn } from '@/lib/cn';
import { setHandledAction } from './actions';

export const metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

const TABS = ['messages', 'subscribers'] as const;
const STATUSES = ['open', 'handled', 'all'] as const;

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('customers.view');
  if (!g.ok) return <Forbidden what="messages" reason={g.reason} />;
  const sp = await searchParams;
  const tab = enumParam(sp.tab, TABS) ?? 'messages';
  const page = intParam(sp.page, 1, 1, 100_000);
  const db = getDb();

  const tabLink = (t: (typeof TABS)[number], label: string) => (
    <Link
      href={`/admin/messages${queryString({ tab: t === 'messages' ? undefined : t })}`}
      aria-current={tab === t ? 'page' : undefined}
      className={cn(
        'border px-3 py-1.5 font-mono text-xs uppercase',
        tab === t ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-paper hover:bg-panel',
      )}
    >
      {label}
    </Link>
  );

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Messages"
        description="Contact-form messages from the shop, and newsletter sign-ups (read only)."
      />
      <nav aria-label="Message views" className="mb-4 flex gap-2">
        {tabLink('messages', 'Contact messages')}
        {tabLink('subscribers', 'Newsletter subscribers')}
      </nav>
      {tab === 'messages' ? (
        <Contact
          status={enumParam(sp.status, STATUSES) ?? 'open'}
          page={page}
          db={db}
          admin={g.admin}
        />
      ) : (
        <Subscribers
          q={first(sp.q)?.trim().slice(0, 100) || undefined}
          page={page}
          db={db}
          admin={g.admin}
        />
      )}
    </section>
  );
}

type Ctx = {
  page: number;
  db: ReturnType<typeof getDb>;
  admin: Parameters<typeof listContactMessagesAdmin>[1];
};

async function Contact({ status, page, db, admin }: Ctx & { status: (typeof STATUSES)[number] }) {
  const list = await listContactMessagesAdmin(db, admin, { status, page, pageSize: 25 });
  const hrefFor = (p: number) =>
    `/admin/messages${queryString({ status: status === 'open' ? undefined : status, page: p > 1 ? p : undefined })}`;
  return (
    <>
      <nav aria-label="Filter by status" className="mb-3 flex gap-3 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/messages${queryString({ status: s === 'open' ? undefined : s })}`}
            aria-current={status === s ? 'true' : undefined}
            className={cn('admin-link', status === s && 'font-semibold no-underline')}
          >
            {s === 'open' ? 'Open' : s === 'handled' ? 'Handled' : 'All'}
          </Link>
        ))}
      </nav>
      {list.items.length === 0 ? (
        <EmptyState title={status === 'open' ? 'No open messages' : 'No messages'}>
          {status === 'open'
            ? 'Everything has been handled.'
            : 'Messages sent through the contact form appear here.'}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.items.map((m) => (
            <li key={m.id} className="admin-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-sm">
                  <strong>{m.name}</strong>{' '}
                  <a className="admin-link" href={`mailto:${m.email}`}>
                    {m.email}
                  </a>
                  <span className="block text-xs text-muted-text">{dateTime(m.createdAt)}</span>
                </p>
                <div className="flex items-center gap-2">
                  {m.handledAt ? (
                    <Badge tone="success">Handled {dateTime(m.handledAt)}</Badge>
                  ) : (
                    <Badge tone="warning">Open</Badge>
                  )}
                  <ActionButton
                    action={setHandledAction.bind(null, m.id, !m.handledAt)}
                    label={
                      m.handledAt
                        ? `Reopen message from ${m.name}`
                        : `Mark message from ${m.name} as handled`
                    }
                  >
                    {m.handledAt ? 'Reopen' : 'Mark handled'}
                  </ActionButton>
                </div>
              </div>
              {m.subject && <p className="mt-2 text-sm font-medium">Subject: {m.subject}</p>}
              <p className="mt-2 whitespace-pre-wrap text-sm">{m.message}</p>
            </li>
          ))}
        </ul>
      )}
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        pageSize={list.pageSize}
        hrefFor={hrefFor}
      />
    </>
  );
}

async function Subscribers({ q, page, db, admin }: Ctx & { q: string | undefined }) {
  const list = await listNewsletterSubscribersAdmin(db, admin, { q, page, pageSize: 50 });
  const hrefFor = (p: number) =>
    `/admin/messages${queryString({ tab: 'subscribers', q, page: p > 1 ? p : undefined })}`;
  return (
    <>
      <FilterBar label="Search subscribers" resetHref="/admin/messages?tab=subscribers">
        <input type="hidden" name="tab" value="subscribers" />
        <FilterInput
          name="q"
          label="Search"
          defaultValue={q}
          placeholder="Name, email or phone"
          className="min-w-56"
        />
      </FilterBar>
      {list.items.length === 0 ? (
        <EmptyState title={q ? 'No subscribers match' : 'No subscribers yet'}>
          {q ? (
            <Link href="/admin/messages?tab=subscribers" className="admin-link">
              Clear the search
            </Link>
          ) : (
            'People who sign up in the shop footer appear here.'
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Newsletter subscribers, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col">Signed up</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.firstName}</th>
                  <td>{s.email}</td>
                  <td>{s.phone ?? 'None'}</td>
                  <td className="whitespace-nowrap">{dateTime(s.createdAt)}</td>
                  <td>
                    {s.unsubscribedAt ? (
                      <Badge tone="muted">Unsubscribed</Badge>
                    ) : (
                      <Badge tone="success">Subscribed</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        pageSize={list.pageSize}
        hrefFor={hrefFor}
      />
    </>
  );
}
