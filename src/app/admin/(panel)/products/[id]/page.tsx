import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { ActionButton, ConfirmAction } from '@/components/admin/confirm-action';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import {
  EmptyState,
  Forbidden,
  Notice,
  PageHeader,
  ProductStatusBadge,
  Rupees,
} from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { noticeText } from '@/lib/admin/notices';
import { gate, type SearchParams } from '@/lib/admin/page';
import { paiseToRupeeInput } from '@/lib/rupees';
import {
  getProductAdmin,
  listCategoriesAdmin,
  listCollectionsAdmin,
  mediaUrl,
} from '@/modules/catalog';
import { can } from '@/modules/staff';
import { listTaxRules } from '@/modules/tax';
import {
  addVariantAction,
  adjustStockAction,
  deleteProductAction,
  moveMediaAction,
  removeMediaAction,
  setCollectionsAction,
  setStatusAction,
  setThresholdAction,
  setVariantActiveAction,
  updateAltAction,
  updateProductAction,
  updateVariantAction,
} from '../actions';
import { ProductFieldset } from '../product-fields';
import { MediaUploader } from './media-uploader';

export const metadata = { title: 'Edit product' };
export const dynamic = 'force-dynamic';

const optionLabel = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, val]) => `${k}: ${val}`)
    .join(', ') || 'No options';

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="products" reason={g.reason} />;
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const detail = await getProductAdmin(db, g.admin, id);
  if (!detail) notFound();
  const { product: p, variants, media, collectionIds, everOrdered } = detail;
  const [categories, collections, taxRules] = await Promise.all([
    listCategoriesAdmin(db, g.admin),
    listCollectionsAdmin(db, g.admin),
    listTaxRules(db),
  ]);
  const canStock = can(g.staff.role, 'inventory.edit');
  const path = `/admin/products/${p.id}`;
  const activeCount = variants.filter((v) => v.active).length;

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/products" className="admin-link">
          Products
        </Link>{' '}
        / {p.name}
      </p>
      <PageHeader
        title={p.name}
        description={
          p.status === 'published' ? (
            <>
              Visible in the shop at{' '}
              <a
                href={`/products/${p.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="admin-link"
              >
                /products/{p.slug} (opens in a new tab)
              </a>
              .
            </>
          ) : (
            `Not visible in the shop while it is ${p.status}.`
          )
        }
        actions={<ProductStatusBadge status={p.status} />}
      />
      <Notice text={noticeText(sp.notice)} />

      <div className="flex max-w-5xl flex-col gap-6">
        <section className="admin-card" aria-labelledby="status-h">
          <h2 id="status-h" className="admin-h2">
            Visibility
          </h2>
          <div className="flex flex-wrap gap-2">
            {p.status !== 'published' && (
              <ConfirmAction
                action={setStatusAction.bind(null, p.id, 'published')}
                trigger="Publish"
                triggerVariant="default"
                triggerSize="default"
                title="Publish this product?"
                description={
                  activeCount === 0
                    ? 'This product has no active variant, so it cannot be published yet.'
                    : 'Customers will see it in the shop, in search and in the sitemap straight away.'
                }
                confirmLabel="Publish"
              />
            )}
            {p.status === 'published' && (
              <ConfirmAction
                action={setStatusAction.bind(null, p.id, 'draft')}
                trigger="Unpublish"
                title="Unpublish this product?"
                description="It disappears from the shop, search and sitemap. Carts that hold it will show it as unavailable. Past orders are not affected."
                confirmLabel="Unpublish"
              />
            )}
            {p.status === 'draft' && (
              <ConfirmAction
                action={setStatusAction.bind(null, p.id, 'archived')}
                trigger="Archive"
                title="Archive this product?"
                description="It is hidden from the shop and kept for your records. You can publish it again later."
                confirmLabel="Archive"
              />
            )}
            {p.status === 'published' && (
              <ConfirmAction
                action={setStatusAction.bind(null, p.id, 'archived')}
                trigger="Archive"
                title="Archive this product?"
                description="It disappears from the shop right away and is kept for your records. Past orders are not affected."
                confirmLabel="Archive"
                destructive
              />
            )}
            {p.status === 'archived' && (
              <ConfirmAction
                action={setStatusAction.bind(null, p.id, 'draft')}
                trigger="Move to draft"
                title="Move this product back to draft?"
                description="It stays hidden from the shop until you publish it."
                confirmLabel="Move to draft"
              />
            )}
          </div>
        </section>

        <ActionForm
          action={updateProductAction.bind(null, p.id)}
          className="admin-card gap-3"
          aria-label="Product details"
        >
          <h2 className="admin-h2">Details</h2>
          <ProductFieldset
            values={p}
            categories={categories.map((c) => ({ value: c.id, label: c.name }))}
            taxRules={taxRules.map((r) => ({ value: r.id, label: r.name }))}
            slugHint="Changing the slug changes the product link."
          />
          <div className="flex items-center gap-3">
            <SubmitButton>Save details</SubmitButton>
            <FormMessage />
          </div>
        </ActionForm>

        <section className="admin-card" aria-labelledby="variants-h">
          <h2 id="variants-h" className="admin-h2">
            Variants and stock
          </h2>
          <div className="overflow-x-auto">
            <table className="admin-table">
              <caption className="sr-only">Variants of {p.name}</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Options</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col" className="num">
                    Compare-at
                  </th>
                  <th scope="col" className="num">
                    On hand
                  </th>
                  <th scope="col" className="num">
                    Reserved
                  </th>
                  <th scope="col" className="num">
                    Available
                  </th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => (
                  <tr key={v.id}>
                    <th scope="row" className="font-mono">
                      {v.sku}
                    </th>
                    <td>{optionLabel(v.optionValues)}</td>
                    <td className="num">
                      <Rupees paise={v.pricePaise} />
                    </td>
                    <td className="num">
                      {v.compareAtPaise ? <Rupees paise={v.compareAtPaise} /> : 'None'}
                    </td>
                    <td className="num">{v.onHand}</td>
                    <td className="num">{v.reserved}</td>
                    <td className="num">{v.available}</td>
                    <td>
                      {v.active ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="muted">Inactive</Badge>
                      )}
                    </td>
                    <td>
                      {v.active ? (
                        <ConfirmAction
                          action={setVariantActiveAction.bind(null, p.id, v.id, false)}
                          trigger="Deactivate"
                          triggerLabel={`Deactivate ${v.sku}`}
                          title={`Deactivate ${v.sku}?`}
                          description="The variant disappears from the shop and cannot be bought. Stock, history and past orders are kept, and you can reactivate it later."
                          confirmLabel="Deactivate variant"
                          destructive
                        />
                      ) : (
                        <ActionButton
                          action={setVariantActiveAction.bind(null, p.id, v.id, true)}
                          label={`Reactivate ${v.sku}`}
                        >
                          Reactivate
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="admin-h2 mt-6">Edit a variant or adjust its stock</h3>
          <div className="flex flex-col gap-2">
            {variants.map((v) => {
              const keys = [...new Set([...Object.keys(v.optionValues), 'Size', 'Colour'])];
              return (
                <details key={v.id} className="border border-line bg-panel-alt p-3">
                  <summary className="cursor-pointer font-mono text-xs uppercase">
                    {v.sku} · {optionLabel(v.optionValues)}
                  </summary>
                  <div className="mt-3 grid gap-6 lg:grid-cols-2">
                    <ActionForm
                      action={updateVariantAction.bind(null, p.id, v.id)}
                      aria-label={`Edit ${v.sku}`}
                    >
                      <Field name="sku" label="SKU" defaultValue={v.sku} required maxLength={64} />
                      <div className="grid grid-cols-2 gap-3">
                        {keys.map((k) => (
                          <Field
                            key={k}
                            name={`opt_${k}`}
                            label={k}
                            defaultValue={v.optionValues[k] ?? ''}
                            maxLength={60}
                          />
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Field
                          name="pricePaise"
                          label="Price (rupees)"
                          defaultValue={paiseToRupeeInput(v.pricePaise)}
                          inputMode="decimal"
                          required
                        />
                        <Field
                          name="compareAtPaise"
                          label="Compare-at (rupees)"
                          defaultValue={v.compareAtPaise ? paiseToRupeeInput(v.compareAtPaise) : ''}
                          inputMode="decimal"
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        <SubmitButton>Save variant</SubmitButton>
                        <FormMessage />
                      </div>
                    </ActionForm>

                    {canStock ? (
                      <div className="flex flex-col gap-4">
                        <ActionForm
                          action={adjustStockAction.bind(null, v.id, path)}
                          aria-label={`Adjust stock for ${v.sku}`}
                        >
                          <p className="text-sm">
                            On hand <strong>{v.onHand}</strong>, reserved {v.reserved}, available{' '}
                            {v.available}.
                          </p>
                          <Field
                            name="delta"
                            label="Change (+ adds, - removes)"
                            inputMode="numeric"
                            required
                            placeholder="-2 or 10"
                          />
                          <Field
                            name="reason"
                            label="Type"
                            kind="select"
                            defaultValue="adjustment"
                            options={[
                              { value: 'adjustment', label: 'Adjustment (restock, shrinkage)' },
                              { value: 'correction', label: 'Correction (count was wrong)' },
                            ]}
                          />
                          <Field name="note" label="Reason" required maxLength={300} />
                          <div className="flex items-center gap-3">
                            <SubmitButton variant="outline">Adjust stock</SubmitButton>
                            <FormMessage />
                          </div>
                        </ActionForm>
                        <ActionForm
                          action={setThresholdAction.bind(null, v.id, path)}
                          aria-label={`Low-stock threshold for ${v.sku}`}
                        >
                          <Field
                            name="threshold"
                            label="Low-stock threshold (units)"
                            defaultValue={v.lowStockThreshold}
                            inputMode="numeric"
                            required
                          />
                          <div className="flex items-center gap-3">
                            <SubmitButton variant="outline">Save threshold</SubmitButton>
                            <FormMessage />
                          </div>
                        </ActionForm>
                        <Link href={`/admin/inventory/${v.id}`} className="admin-link text-sm">
                          Stock movement history
                        </Link>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-text">Your role cannot change stock.</p>
                    )}
                  </div>
                </details>
              );
            })}
          </div>

          <details className="mt-4 border border-line p-3">
            <summary className="cursor-pointer font-mono text-xs uppercase">Add a variant</summary>
            <ActionForm
              action={addVariantAction.bind(null, p.id)}
              className="mt-3"
              aria-label="Add a variant"
            >
              <div className="grid gap-3 md:grid-cols-3">
                <Field name="sku" label="SKU" required maxLength={64} autoComplete="off" />
                <Field name="opt_Size" label="Size" maxLength={60} />
                <Field name="opt_Colour" label="Colour (optional)" maxLength={60} />
                <Field name="pricePaise" label="Price (rupees)" inputMode="decimal" required />
                <Field name="compareAtPaise" label="Compare-at (rupees)" inputMode="decimal" />
                <Field
                  name="stock"
                  label="Opening stock"
                  inputMode="numeric"
                  required
                  defaultValue="0"
                />
              </div>
              <div className="flex items-center gap-3">
                <SubmitButton>Add variant</SubmitButton>
                <FormMessage />
              </div>
            </ActionForm>
          </details>
        </section>

        <section className="admin-card" aria-labelledby="media-h">
          <h2 id="media-h" className="admin-h2">
            Images
          </h2>
          {media.length === 0 ? (
            <EmptyState title="No images yet">
              The first image is the cover shown in listings.
            </EmptyState>
          ) : (
            <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {media.map((m, i) => (
                <li key={m.id} className="flex flex-col gap-2 border border-line p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mediaUrl(m.objectKey)}
                    alt={m.alt}
                    width={m.width}
                    height={m.height}
                    className="h-40 w-full bg-panel object-contain"
                    loading="lazy"
                  />
                  <p className="font-mono text-xs text-muted-text">
                    {i === 0 ? 'Cover · ' : ''}
                    {m.width} x {m.height}
                  </p>
                  <ActionForm
                    action={updateAltAction.bind(null, p.id, m.id)}
                    aria-label={`Alt text for image ${i + 1}`}
                  >
                    <Field
                      name="alt"
                      label="Alt text"
                      defaultValue={m.alt}
                      required
                      maxLength={200}
                    />
                    <SubmitButton variant="outline" size="sm">
                      Save alt text
                    </SubmitButton>
                    <FormMessage />
                  </ActionForm>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      action={moveMediaAction.bind(null, p.id, m.id, 'up')}
                      label={`Move image ${i + 1} earlier`}
                      disabled={i === 0}
                    >
                      Move earlier
                    </ActionButton>
                    <ActionButton
                      action={moveMediaAction.bind(null, p.id, m.id, 'down')}
                      label={`Move image ${i + 1} later`}
                      disabled={i === media.length - 1}
                    >
                      Move later
                    </ActionButton>
                    <ConfirmAction
                      action={removeMediaAction.bind(null, p.id, m.id)}
                      trigger="Remove"
                      triggerLabel={`Remove image ${i + 1}`}
                      title="Remove this image?"
                      description="The image is taken off this product and the stored file is deleted. This cannot be undone; upload it again if you need it back."
                      confirmLabel="Remove image"
                      destructive
                    />
                  </div>
                </li>
              ))}
            </ol>
          )}
          <h3 className="admin-h2 mt-6">Upload an image</h3>
          <MediaUploader productId={p.id} />
        </section>

        <ActionForm
          action={setCollectionsAction.bind(null, p.id)}
          className="admin-card"
          aria-label="Collections"
        >
          <h2 className="admin-h2">Collections</h2>
          {collections.length === 0 ? (
            <p className="text-sm text-muted-text">
              No collections exist yet.{' '}
              <Link href="/admin/products/categories" className="admin-link">
                Create one
              </Link>
              .
            </p>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Collections this product belongs to</legend>
              {collections.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="collectionId"
                    value={c.id}
                    defaultChecked={collectionIds.includes(c.id)}
                    className="size-5 accent-ink"
                  />
                  {c.name}
                  {!c.published && <Badge tone="muted">Unpublished</Badge>}
                </label>
              ))}
            </fieldset>
          )}
          {collections.length > 0 && (
            <div className="flex items-center gap-3">
              <SubmitButton>Save collections</SubmitButton>
              <FormMessage />
            </div>
          )}
        </ActionForm>

        <section className="admin-card border-danger" aria-labelledby="danger-h">
          <h2 id="danger-h" className="admin-h2">
            Delete product
          </h2>
          <p className="mb-3 text-sm">
            {everOrdered
              ? 'This product appears on past orders, so it cannot be erased. Deleting archives it and hides it from the shop; the orders keep their copy of the product details.'
              : 'This product has never been ordered. Deleting removes it for good, with its variants, images and stock history.'}
          </p>
          <ConfirmAction
            action={deleteProductAction.bind(null, p.id)}
            trigger="Delete product"
            triggerVariant="destructive"
            title={`Delete ${p.name}?`}
            description={
              everOrdered
                ? 'Because it was ordered before, the product will be archived and hidden instead of erased. Past orders keep their details.'
                : 'The product, its variants, image records and stock history will be permanently erased. This cannot be undone.'
            }
            confirmLabel={everOrdered ? 'Archive and hide' : 'Delete permanently'}
            destructive
          />
        </section>
      </div>
    </section>
  );
}
