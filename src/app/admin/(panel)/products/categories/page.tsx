import Link from 'next/link';
import { getDb } from '@/db/client';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import { EmptyState, Forbidden, PageHeader } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { gate } from '@/lib/admin/page';
import { listCategoriesAdmin, listCollectionsAdmin } from '@/modules/catalog';
import {
  createCategoryAction,
  createCollectionAction,
  deleteCategoryAction,
  deleteCollectionAction,
  updateCategoryAction,
  updateCollectionAction,
} from '../actions';

export const metadata = { title: 'Categories and collections' };
export const dynamic = 'force-dynamic';

export default async function TaxonomyPage() {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="categories and collections" reason={g.reason} />;
  const db = getDb();
  const [categories, collections] = await Promise.all([
    listCategoriesAdmin(db, g.admin),
    listCollectionsAdmin(db, g.admin),
  ]);
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  const parentOptions = (exceptId?: string) => [
    { value: '', label: 'No parent' },
    ...categories.filter((c) => c.id !== exceptId).map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <section aria-labelledby="page-title">
      <p className="mb-2 text-sm">
        <Link href="/admin/products" className="admin-link">
          Products
        </Link>{' '}
        / Categories and collections
      </p>
      <PageHeader
        title="Categories and collections"
        description="A product has one category and can be in many collections. Add products to a collection from the product page."
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="cat-h" className="flex flex-col gap-3">
          <h2 id="cat-h" className="admin-h2">
            Categories
          </h2>
          {categories.length === 0 ? (
            <EmptyState title="No categories yet">Create one below.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {categories.map((c) => (
                <li key={c.id} className="admin-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">
                      <strong>{c.name}</strong>{' '}
                      <span className="font-mono text-xs text-muted-text">/{c.slug}</span>
                      {c.parentId && (
                        <span className="text-xs text-muted-text">
                          {' '}
                          inside {nameOf.get(c.parentId) ?? 'unknown'}
                        </span>
                      )}{' '}
                      <Badge tone="muted">{c.productCount} products</Badge>
                    </p>
                    <ConfirmAction
                      action={deleteCategoryAction.bind(null, c.id)}
                      trigger="Delete"
                      triggerLabel={`Delete category ${c.name}`}
                      title={`Delete the category ${c.name}?`}
                      description={`The category is removed. ${c.productCount} product(s) in it become uncategorised (they stay in the shop). A category that has sub-categories cannot be deleted.`}
                      confirmLabel="Delete category"
                      destructive
                    />
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-mono text-xs uppercase">Edit</summary>
                    <ActionForm
                      action={updateCategoryAction.bind(null, c.id)}
                      className="mt-2"
                      aria-label={`Edit category ${c.name}`}
                    >
                      <Field
                        name="name"
                        label="Name"
                        defaultValue={c.name}
                        required
                        maxLength={120}
                      />
                      <Field
                        name="slug"
                        label="URL slug"
                        defaultValue={c.slug}
                        required
                        maxLength={80}
                      />
                      <Field
                        name="parentId"
                        label="Parent category"
                        kind="select"
                        defaultValue={c.parentId ?? ''}
                        options={parentOptions(c.id)}
                      />
                      <Field
                        name="position"
                        label="Sort position"
                        defaultValue={c.position}
                        inputMode="numeric"
                      />
                      <div className="flex items-center gap-3">
                        <SubmitButton>Save category</SubmitButton>
                        <FormMessage />
                      </div>
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <ActionForm
            action={createCategoryAction}
            className="admin-card"
            aria-label="New category"
          >
            <h3 className="admin-h2">New category</h3>
            <Field name="name" label="Name" required maxLength={120} />
            <Field
              name="slug"
              label="URL slug"
              maxLength={80}
              hint="Leave blank to build it from the name."
            />
            <Field
              name="parentId"
              label="Parent category"
              kind="select"
              options={parentOptions()}
            />
            <Field name="position" label="Sort position" defaultValue="0" inputMode="numeric" />
            <div className="flex items-center gap-3">
              <SubmitButton pendingLabel="Creating">Create category</SubmitButton>
              <FormMessage />
            </div>
          </ActionForm>
        </section>

        <section aria-labelledby="col-h" className="flex flex-col gap-3">
          <h2 id="col-h" className="admin-h2">
            Collections
          </h2>
          {collections.length === 0 ? (
            <EmptyState title="No collections yet">Create one below.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {collections.map((c) => (
                <li key={c.id} className="admin-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">
                      <strong>{c.name}</strong>{' '}
                      <span className="font-mono text-xs text-muted-text">
                        /collections/{c.slug}
                      </span>{' '}
                      <Badge tone="muted">{c.productCount} products</Badge>{' '}
                      {!c.published && <Badge tone="warning">Unpublished</Badge>}
                    </p>
                    <ConfirmAction
                      action={deleteCollectionAction.bind(null, c.id)}
                      trigger="Delete"
                      triggerLabel={`Delete collection ${c.name}`}
                      title={`Delete the collection ${c.name}?`}
                      description={`The collection page disappears from the shop. Its ${c.productCount} product(s) are not deleted, they just leave the collection.`}
                      confirmLabel="Delete collection"
                      destructive
                    />
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer font-mono text-xs uppercase">Edit</summary>
                    <ActionForm
                      action={updateCollectionAction.bind(null, c.id)}
                      className="mt-2"
                      aria-label={`Edit collection ${c.name}`}
                    >
                      <Field
                        name="name"
                        label="Name"
                        defaultValue={c.name}
                        required
                        maxLength={120}
                      />
                      <Field
                        name="slug"
                        label="URL slug"
                        defaultValue={c.slug}
                        required
                        maxLength={80}
                      />
                      <Field
                        name="description"
                        label="Description"
                        kind="textarea"
                        rows={2}
                        defaultValue={c.description}
                        maxLength={1000}
                      />
                      <Field
                        name="position"
                        label="Sort position"
                        defaultValue={c.position}
                        inputMode="numeric"
                      />
                      <Field
                        name="published"
                        label="Published (visible in the shop)"
                        kind="checkbox"
                        defaultValue={c.published}
                      />
                      <div className="flex items-center gap-3">
                        <SubmitButton>Save collection</SubmitButton>
                        <FormMessage />
                      </div>
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <ActionForm
            action={createCollectionAction}
            className="admin-card"
            aria-label="New collection"
          >
            <h3 className="admin-h2">New collection</h3>
            <Field name="name" label="Name" required maxLength={120} />
            <Field
              name="slug"
              label="URL slug"
              maxLength={80}
              hint="Leave blank to build it from the name."
            />
            <Field
              name="description"
              label="Description"
              kind="textarea"
              rows={2}
              maxLength={1000}
            />
            <Field name="position" label="Sort position" defaultValue="0" inputMode="numeric" />
            <Field
              name="published"
              label="Published (visible in the shop)"
              kind="checkbox"
              defaultValue={true}
            />
            <div className="flex items-center gap-3">
              <SubmitButton pendingLabel="Creating">Create collection</SubmitButton>
              <FormMessage />
            </div>
          </ActionForm>
        </section>
      </div>
    </section>
  );
}
