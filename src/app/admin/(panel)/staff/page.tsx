import { getDb } from '@/db/client';
import { ActionButton, ConfirmAction } from '@/components/admin/confirm-action';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import { EmptyState, Forbidden, Notice, PageHeader, dateOnly } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { noticeText } from '@/lib/admin/notices';
import { gate, type SearchParams } from '@/lib/admin/page';
import { listStaff, requiresTwoFactor, ROLES } from '@/modules/staff';
import { changeRoleAction, createStaffAction, setActiveAction } from './actions';

export const metadata = { title: 'Staff' };
export const dynamic = 'force-dynamic';

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including staff and settings.',
  manager: 'Orders, refunds, catalog, inventory, reports and the audit log.',
  support: 'View orders and customers, add order notes.',
};

export default async function StaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const g = await gate('staff.manage');
  if (!g.ok) return <Forbidden what="staff accounts" reason={g.reason} />;
  const sp = await searchParams;
  const staff = await listStaff(getDb(), g.admin);
  const roleOptions = ROLES.map((r) => ({
    value: r,
    label: `${r[0]!.toUpperCase()}${r.slice(1)}: ${ROLE_HELP[r]}`,
  }));

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Staff"
        description="Only an owner can create accounts, change roles or deactivate people. Owners and managers must set up an authenticator app (2FA) at their first sign-in."
      />
      <Notice text={noticeText(sp.notice)} />
      {staff.length === 0 ? (
        <EmptyState title="No staff yet" />
      ) : (
        <div className="overflow-x-auto border border-line">
          <table className="admin-table">
            <caption className="sr-only">Staff accounts</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">2FA</th>
                <th scope="col">State</th>
                <th scope="col">Added</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {staff.map((m) => {
                const you = m.userId === g.staff.userId;
                return (
                  <tr key={m.userId}>
                    <th scope="row">
                      {m.name}
                      {you && <span className="font-normal text-muted-text"> (you)</span>}
                      <span className="block text-xs font-normal text-muted-text">{m.email}</span>
                    </th>
                    <td>
                      <Badge tone={m.role === 'owner' ? 'neutral' : 'muted'}>{m.role}</Badge>
                    </td>
                    <td>
                      {m.twoFactorEnabled ? (
                        <Badge tone="success">On</Badge>
                      ) : requiresTwoFactor(m.role) ? (
                        <Badge tone="warning">Required, not set up</Badge>
                      ) : (
                        <Badge tone="muted">Not required</Badge>
                      )}
                    </td>
                    <td>
                      {m.active ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="danger">Deactivated</Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap">{dateOnly(m.createdAt)}</td>
                    <td>
                      {you ? (
                        <span className="text-xs text-muted-text">
                          You cannot change or deactivate yourself.
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <ConfirmAction
                            action={changeRoleAction.bind(null, m.userId)}
                            trigger="Change role"
                            triggerLabel={`Change role of ${m.email}`}
                            title={`Change the role of ${m.name}?`}
                            description={`${m.email} is ${m.role} today. The new role applies on their next request. The last active owner cannot be demoted. The change is recorded in the audit log.`}
                            confirmLabel="Change role"
                          >
                            <Field
                              name="role"
                              label="New role"
                              kind="select"
                              defaultValue={m.role}
                              options={roleOptions}
                            />
                          </ConfirmAction>
                          {m.active ? (
                            <ConfirmAction
                              action={setActiveAction.bind(null, m.userId, false)}
                              trigger="Deactivate"
                              triggerLabel={`Deactivate ${m.email}`}
                              title={`Deactivate ${m.name}?`}
                              description={`${m.email} is signed out everywhere and cannot sign in to the admin again until you reactivate the account. Their history stays in the audit log. The last active owner cannot be deactivated.`}
                              confirmLabel="Deactivate account"
                              destructive
                            />
                          ) : (
                            <ActionButton
                              action={setActiveAction.bind(null, m.userId, true)}
                              label={`Reactivate ${m.email}`}
                            >
                              Reactivate
                            </ActionButton>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ActionForm
        action={createStaffAction}
        className="admin-card mt-6 max-w-xl"
        aria-label="Create a staff account"
      >
        <h2 className="admin-h2">Create a staff account</h2>
        <Field name="name" label="Name" required maxLength={120} autoComplete="off" />
        <Field name="email" label="Email" type="email" required autoComplete="off" />
        <Field
          name="role"
          label="Role"
          kind="select"
          defaultValue="support"
          options={roleOptions}
        />
        <Field
          name="password"
          label="Temporary password"
          type="password"
          required
          minLength={10}
          maxLength={128}
          autoComplete="new-password"
          hint="At least 10 characters. Tell the person in person; owners and managers set up 2FA at first sign-in."
        />
        <div className="flex items-center gap-3">
          <SubmitButton pendingLabel="Creating">Create account</SubmitButton>
          <FormMessage />
        </div>
      </ActionForm>
    </section>
  );
}
