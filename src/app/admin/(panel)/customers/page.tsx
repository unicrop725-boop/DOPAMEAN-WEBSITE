import Link from 'next/link';
import { getDb } from '@/db/client';
import { FilterBar, FilterInput } from '@/components/admin/filter-bar';
import { EmptyState, Forbidden, PageHeader, Pagination, dateOnly } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { first, gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { listCustomersAdmin } from '@/modules/customers';

export const metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('customers.view');
  if (!g.ok) return <Forbidden what="customers" reason={g.reason} />;
  const sp = await searchParams;
  const q = first(sp.q)?.trim().slice(0, 100) || undefined;
  const page = intParam(sp.page, 1, 1, 100_000);
  const list = await listCustomersAdmin(getDb(), g.admin, { q, page, pageSize: 25 });
  const hrefFor = (p: number) =>
    `/admin/customers${queryString({ q, page: p > 1 ? p : undefined })}`;

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Customers"
        description="Accounts created in the shop. Guest checkouts have no account: find them under Orders."
      />
      <FilterBar label="Search customers" resetHref="/admin/customers">
        <FilterInput
          name="q"
          label="Search"
          defaultValue={q}
          placeholder="Name, email or phone"
          className="min-w-56"
        />
      </FilterBar>
      {list.items.length === 0 ? (
        <EmptyState title={q ? 'No customers match' : 'No customers yet'}>
          {q ? (
            <Link href="/admin/customers" className="admin-link">
              Clear the search
            </Link>
          ) : (
            'Customers appear here after they register.'
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Customer accounts, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col">Joined</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((c) => (
                <tr key={c.userId}>
                  <th scope="row">
                    <Link href={`/admin/customers/${c.userId}`} className="admin-link">
                      {c.name}
                    </Link>
                  </th>
                  <td>{c.email}</td>
                  <td>{c.phone ?? 'None'}</td>
                  <td className="whitespace-nowrap">{dateOnly(c.createdAt)}</td>
                  <td>
                    {c.deleted ? (
                      <Badge tone="muted">Deleted</Badge>
                    ) : c.emailVerified ? (
                      <Badge tone="success">Verified</Badge>
                    ) : (
                      <Badge tone="warning">Email not verified</Badge>
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
    </section>
  );
}
