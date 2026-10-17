import { getDb } from '@/db/client';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import { EmptyState, Forbidden, Notice, PageHeader } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { noticeText } from '@/lib/admin/notices';
import { gate, type SearchParams } from '@/lib/admin/page';
import { paymentProviderStatus } from '@/lib/admin/settings';
import { paiseToRupeeInput } from '@/lib/rupees';
import { getSettings } from '@/lib/settings';
import { GST_STATES } from '@/modules/customers';
import { listTaxRules } from '@/modules/tax';
import { createTaxRuleAction, saveSettingsAction } from './actions';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const percent = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('settings.manage');
  if (!g.ok) return <Forbidden what="settings" reason={g.reason} />;
  const sp = await searchParams;
  const db = getDb();
  const [s, rules] = await Promise.all([getSettings(db), listTaxRules(db)]);
  const provider = paymentProviderStatus();

  return (
    <section aria-labelledby="page-title">
      <PageHeader
        title="Settings"
        description="Owner only. Every change is recorded in the audit log with the old and new values."
      />
      <Notice text={noticeText(sp.notice)} />
      <div className="flex max-w-4xl flex-col gap-6">
        <ActionForm
          action={saveSettingsAction}
          className="admin-card gap-4"
          aria-label="Store settings"
        >
          <h2 className="admin-h2">Store</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              name="storeName"
              label="Store name"
              defaultValue={s.storeName}
              required
              maxLength={80}
            />
            <Field
              name="contactEmail"
              label="Contact email"
              type="email"
              defaultValue={s.contactEmail}
              hint="Staff alerts and contact-form messages go here."
            />
            <Field
              name="gstin"
              label="GSTIN"
              defaultValue={s.gstin}
              maxLength={15}
              hint="15 characters. Printed on invoices. Leave blank until you have it."
            />
            <Field
              name="sellerStateCode"
              label="Seller state (GST)"
              kind="select"
              defaultValue={s.sellerStateCode}
              options={GST_STATES.map((st) => ({ value: st.code, label: `${st.code} ${st.name}` }))}
              hint="Orders to this state charge CGST + SGST; other states charge IGST."
            />
          </div>

          <h2 className="admin-h2 mt-2">Shipping</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              name="shippingFlat"
              label="Flat shipping rate (rupees)"
              defaultValue={paiseToRupeeInput(s.shippingFlatPaise)}
              inputMode="decimal"
              required
            />
            <Field
              name="freeShippingThreshold"
              label="Free shipping from (rupees)"
              defaultValue={paiseToRupeeInput(s.freeShippingThresholdPaise)}
              inputMode="decimal"
              required
              hint="0 means shipping is always free."
            />
          </div>

          <h2 className="admin-h2 mt-2">Cash on delivery</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              name="codEnabled"
              label="Offer cash on delivery"
              kind="checkbox"
              defaultValue={s.codEnabled}
              className="md:col-span-2"
            />
            <Field
              name="codMax"
              label="Maximum COD order value (rupees)"
              defaultValue={paiseToRupeeInput(s.codMaxPaise)}
              inputMode="decimal"
              required
            />
            <Field
              name="codFee"
              label="COD fee (rupees)"
              defaultValue={paiseToRupeeInput(s.codFeePaise)}
              inputMode="decimal"
              required
              hint="0 means no fee."
            />
          </div>
          <div className="flex items-center gap-3">
            <SubmitButton>Save settings</SubmitButton>
            <FormMessage />
          </div>
        </ActionForm>

        <section className="admin-card" aria-labelledby="provider-h">
          <h2 id="provider-h" className="admin-h2">
            Payment provider
          </h2>
          <p className="text-sm">
            Razorpay:{' '}
            {provider.configured ? (
              <Badge tone="success">
                Configured{provider.mode ? ` (${provider.mode} mode)` : ''}
              </Badge>
            ) : (
              <Badge tone="warning">Not configured</Badge>
            )}{' '}
            Webhook secret:{' '}
            {provider.webhookConfigured ? (
              <Badge tone="success">Set</Badge>
            ) : (
              <Badge tone="warning">Not set</Badge>
            )}
          </p>
          <p className="mt-2 text-sm text-muted-text">
            {provider.configured
              ? 'Online payment is offered at checkout.'
              : 'Only cash on delivery is offered until the Razorpay keys are added to the server environment.'}{' '}
            Keys are read from the server environment and are never shown or editable here.
          </p>
        </section>

        <section className="admin-card" aria-labelledby="tax-h">
          <h2 id="tax-h" className="admin-h2">
            GST rules
          </h2>
          <p className="mb-3 text-sm text-muted-text">
            Prices include GST. A product points at one rule. A rule cannot be edited once created,
            so past orders always keep the rate they were charged: add a new rule and move products
            to it instead.
          </p>
          {rules.length === 0 ? (
            <EmptyState title="No GST rules yet">
              Products without a rule are charged 0% GST. Add a rule below.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto border border-line">
              <table className="admin-table">
                <caption className="sr-only">GST rules</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.name}</th>
                      <td>{r.kind === 'fixed' ? 'Fixed rate' : 'Price slab'}</td>
                      <td>
                        {r.kind === 'fixed'
                          ? percent(r.rateBp)
                          : `${percent(r.rateBp)} up to Rs. ${paiseToRupeeInput(Number(r.slabThresholdPaise))} per unit, ${percent(Number(r.rateBpAbove))} above`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ActionForm
            action={createTaxRuleAction}
            className="mt-4 border-t border-line pt-4"
            aria-label="Add a GST rule"
          >
            <h3 className="admin-h2">Add a rule</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <Field name="name" label="Name" required maxLength={80} placeholder="Apparel GST" />
              <Field
                name="kind"
                label="Type"
                kind="select"
                defaultValue="fixed"
                options={[
                  { value: 'fixed', label: 'Fixed rate' },
                  { value: 'slab', label: 'Price slab (two rates around a unit price)' },
                ]}
              />
              <Field
                name="rate"
                label="Rate (%)"
                inputMode="decimal"
                required
                hint="For a slab: the rate up to the threshold. For example 5 or 12.5"
              />
              <Field
                name="slabThreshold"
                label="Slab threshold (rupees per unit)"
                inputMode="decimal"
                hint="Slab rules only."
              />
              <Field
                name="rateAbove"
                label="Rate above the threshold (%)"
                inputMode="decimal"
                hint="Slab rules only."
              />
            </div>
            <div className="flex items-center gap-3">
              <SubmitButton pendingLabel="Adding">Add GST rule</SubmitButton>
              <FormMessage />
            </div>
          </ActionForm>
        </section>
      </div>
    </section>
  );
}
