import Link from 'next/link';
import { getDb } from '@/db/client';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { EmptyState, Forbidden, PageHeader, Pagination, dateTime } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { auditFilterOptionsAdmin, searchAuditAdmin } from '@/lib/admin/audit';
import { dateParam, first, gate, intParam, queryString, type SearchParams } from '@/lib/admin/page';
import { istStartOf } from '@/modules/orders';
import { listStaffDirectory, lookupStaff } from '@/modules/staff';

export const metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

/** Where an audited thing can be opened, when it has an admin page. */
function entityHref(entity: string, id: string): string | null {
  const seg = encodeURIComponent(id);
  if (entity === 'order') return `/admin/orders/${seg}`;
  if (entity === 'product') return `/admin/products/${seg}`;
  if (entity === 'variant') return `/admin/inventory/${seg}`;
  if (entity === 'content_page') return `/admin/content/${seg}`;
  return null;
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="font-mono text-xs uppercase text-muted-text">{label}</p>
      <pre className="max-h-72 overflow-auto border border-line bg-panel-alt p-2 text-xs whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const g = await gate('audit.view');
  if (!g.ok) return <Forbidden what="the audit log" reason={g.reason} />;
  const sp = await searchParams;
  const db = getDb();
  const entity = first(sp.entity)?.slice(0, 60) || undefined;
  const entityId = first(sp.entityId)?.trim().slice(0, 100) || undefined;
  const actorUserId = first(sp.actor)?.slice(0, 100) || undefined;
  const action = first(sp.action)?.trim().slice(0, 60) || undefined;
  const from = dateParam(sp.from);
  const to = dateParam(sp.to);
  const page = intParam(sp.page, 1, 1, 100_000);

  const [options, directory, list] = await Promise.all([
    auditFilterOptionsAdmin(db, g.admin),
    listStaffDirectory(db),
    searchAuditAdmin(db, g.admin, {
      entity,
      entityId,
      actorUserId,
      action,
      from: from ? istStartOf(from) : undefined,
      to: to ? new Date(istStartOf(to).getTime() + DAY_MS) : undefined,
      page,
      pageSize: 50,
    }),
  ]);
  const people = await lookupStaff(
    db,
    list.items.map((r) => r.actorUserId),
  );
  const base = { entity, entityId, actor: actorUserId, action, from, to };
  const hrefFor = (p: number) =>
    `/admin/audit${queryString({ ...base, page: p > 1 ? p : undefined })}`;
  const filtered = Object.values(base).some(Boolean);

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Audit log"
        description="Every privileged action: who did it, to what, what changed, from which address. The log is append-only: entries cannot be edited or deleted. Dates are India time."
      />
      <FilterBar label="Filter the audit log" resetHref="/admin/audit">
        <FilterSelect
          name="entity"
          label="Entity"
          defaultValue={entity}
          options={options.entities.map((e) => ({ value: e, label: e }))}
        />
        <FilterInput
          name="entityId"
          label="Entity id"
          type="text"
          defaultValue={entityId}
          placeholder="Order, product or variant id"
        />
        <FilterSelect
          name="actor"
          label="Who"
          defaultValue={actorUserId}
          allLabel="Anyone"
          options={directory.map((d) => ({ value: d.userId, label: d.email }))}
        />
        <FilterSelect
          name="action"
          label="Action"
          defaultValue={action}
          options={options.actions.map((a) => ({ value: a, label: a }))}
        />
        <FilterInput name="from" label="From" type="date" defaultValue={from} />
        <FilterInput name="to" label="To (inclusive)" type="date" defaultValue={to} />
      </FilterBar>

      {list.items.length === 0 ? (
        <EmptyState title={filtered ? 'No entries match these filters' : 'No audit entries yet'}>
          {filtered ? (
            <Link href="/admin/audit" className="admin-link">
              Clear the filters
            </Link>
          ) : (
            'Entries appear as soon as someone changes something in the admin.'
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Audit entries, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Address</th>
                <th scope="col">Changes</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((r) => {
                const href = entityHref(r.entity, r.entityId);
                const who = people.get(r.actorUserId);
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{dateTime(r.at)}</td>
                    <td>
                      {who?.email ?? 'unknown or removed user'}
                      <span className="block">
                        <Badge tone="muted">{r.actorRole}</Badge>
                      </span>
                    </td>
                    <td className="font-mono text-xs">{r.action}</td>
                    <td>
                      <span className="text-xs">{r.entity}</span>
                      <span className="block font-mono text-xs break-all">
                        {href ? (
                          <Link href={href} className="admin-link">
                            {r.entityId}
                          </Link>
                        ) : (
                          r.entityId
                        )}
                      </span>
                    </td>
                    <td className="font-mono text-xs">{r.ip ?? 'n/a'}</td>
                    <td className="min-w-48">
                      {r.before == null && r.after == null ? (
                        <span className="text-xs text-muted-text">No details</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-xs underline">
                            Before and after
                            <span className="sr-only">
                              {' '}
                              for {r.action} {r.entityId}
                            </span>
                          </summary>
                          <div className="mt-2 flex flex-col gap-2">
                            <Json label="Before" value={r.before} />
                            <Json label="After" value={r.after} />
                            {r.userAgent && (
                              <p className="text-xs text-muted-text break-words">{r.userAgent}</p>
                            )}
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
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
