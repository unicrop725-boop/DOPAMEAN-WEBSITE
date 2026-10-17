import Link from 'next/link';
import { getDb } from '@/db/client';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import { Forbidden, PageHeader } from '@/components/admin/parts';
import { gate } from '@/lib/admin/page';
import { listCategoriesAdmin } from '@/modules/catalog';
import { listTaxRules } from '@/modules/tax';
import { createProductAction } from '../actions';
import { ProductFieldset } from '../product-fields';

export const metadata = { title: 'New product' };
export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="products" reason={g.reason} />;
  const db = getDb();
  const [categories, taxRules] = await Promise.all([
    listCategoriesAdmin(db, g.admin),
    listTaxRules(db),
  ]);

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/products" className="admin-link">
          Products
        </Link>{' '}
        / New
      </p>
      <PageHeader
        title="New product"
        description="The product starts as a draft. Add images and more sizes on the next screen, then publish it."
      />
      <ActionForm action={createProductAction} className="max-w-4xl gap-6" aria-label="New product">
        <section className="admin-card flex flex-col gap-3" aria-labelledby="details-h">
          <h2 id="details-h" className="admin-h2">
            Details
          </h2>
          <ProductFieldset
            categories={categories.map((c) => ({ value: c.id, label: c.name }))}
            taxRules={taxRules.map((r) => ({ value: r.id, label: r.name }))}
            slugHint="Leave blank to build it from the name."
          />
        </section>
        <section className="admin-card flex flex-col gap-3" aria-labelledby="variant-h">
          <h2 id="variant-h" className="admin-h2">
            First variant
          </h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Field
              name="sku"
              label="SKU"
              required
              maxLength={64}
              autoComplete="off"
              hint="Must be unique across the shop."
            />
            <Field name="opt_Size" label="Size" placeholder="M" maxLength={60} />
            <Field name="opt_Colour" label="Colour (optional)" maxLength={60} />
            <Field
              name="pricePaise"
              label="Price (rupees, GST included)"
              inputMode="decimal"
              required
              placeholder="1499"
            />
            <Field
              name="compareAtPaise"
              label="Compare-at price (rupees)"
              inputMode="decimal"
              hint="Higher than the price; shown struck through."
            />
            <Field
              name="stock"
              label="Opening stock (units)"
              inputMode="numeric"
              required
              defaultValue="0"
            />
          </div>
        </section>
        <div className="flex items-center gap-3">
          <SubmitButton pendingLabel="Creating">Create draft product</SubmitButton>
          <FormMessage />
        </div>
      </ActionForm>
    </section>
  );
}
