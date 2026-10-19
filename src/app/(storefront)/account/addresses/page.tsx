import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { requireUser } from '@/lib/session';
import { GST_STATES, listAddresses, stateName } from '@/modules/customers';
import { AccountShell } from '@/storefront/account-shell';
import { AddressForm, AddressList } from '@/storefront/address-ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Addresses | DOPAMEAN' };

type Props = { searchParams: Promise<{ edit?: string; new?: string }> };

export default async function AddressesPage({ searchParams }: Props) {
  const sp = await searchParams;
  const user = await requireUser('/account/addresses');
  const rows = await listAddresses(getDb(), user.id);
  const editing = sp.edit ? rows.find((r) => r.id === sp.edit) : undefined;
  const showForm = Boolean(editing) || sp.new === '1';

  return (
    <AccountShell current="/account/addresses" title="MY ADDRESSES">
      {showForm ? (
        <AddressForm
          key={editing?.id ?? 'new'}
          states={GST_STATES}
          initial={
            editing && {
              id: editing.id,
              fullName: editing.fullName,
              line1: editing.line1,
              line2: editing.line2 ?? '',
              city: editing.city,
              stateCode: editing.stateCode,
              pincode: editing.pincode,
              phone: editing.phone,
              isDefault: editing.isDefault,
            }
          }
        />
      ) : (
        <AddressList
          addresses={rows.map((r) => ({
            id: r.id,
            fullName: r.fullName,
            line1: r.line1,
            line2: r.line2,
            city: r.city,
            state: stateName(r.stateCode) ?? r.stateCode,
            pincode: r.pincode,
            phone: r.phone,
            isDefault: r.isDefault,
          }))}
        />
      )}
    </AccountShell>
  );
}
