import { Field } from '@/components/admin/forms';

type Option = { value: string; label: string };

export type ProductDefaults = {
  name?: string;
  slug?: string;
  description?: string | null;
  categoryId?: string | null;
  hsnCode?: string | null;
  taxRuleId?: string | null;
  materials?: string | null;
  careGuide?: string | null;
  shippingReturns?: string | null;
  modelInfo?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
};

/** The descriptive fields shared by "new product" and "edit product". Must sit inside an ActionForm. */
export function ProductFieldset({
  values = {},
  categories,
  taxRules,
  slugHint,
}: {
  values?: ProductDefaults;
  categories: Option[];
  taxRules: Option[];
  slugHint: string;
}) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field name="name" label="Name" defaultValue={values.name} required maxLength={200} />
        <Field
          name="slug"
          label="URL slug"
          defaultValue={values.slug}
          hint={slugHint}
          maxLength={80}
          autoComplete="off"
        />
        <Field
          name="categoryId"
          label="Category"
          kind="select"
          defaultValue={values.categoryId ?? ''}
          options={[{ value: '', label: 'No category' }, ...categories]}
        />
        <Field
          name="hsnCode"
          label="HSN code"
          defaultValue={values.hsnCode}
          maxLength={16}
          hint="Printed on invoices and copied onto every order line."
        />
        <Field
          name="taxRuleId"
          label="GST rule"
          kind="select"
          defaultValue={values.taxRuleId ?? ''}
          options={[{ value: '', label: 'None (0% GST)' }, ...taxRules]}
          hint="Rules are managed in Settings. Prices already include GST."
          className="md:col-span-2"
        />
      </div>
      <Field
        name="description"
        label="Description"
        kind="textarea"
        rows={5}
        defaultValue={values.description}
        maxLength={10000}
      />
      <div className="grid gap-3 md:grid-cols-3">
        <Field
          name="materials"
          label="Materials tab"
          kind="textarea"
          rows={3}
          defaultValue={values.materials}
          maxLength={5000}
        />
        <Field
          name="careGuide"
          label="Care tab"
          kind="textarea"
          rows={3}
          defaultValue={values.careGuide}
          maxLength={5000}
        />
        <Field
          name="shippingReturns"
          label="Shipping and returns tab"
          kind="textarea"
          rows={3}
          defaultValue={values.shippingReturns}
          maxLength={5000}
        />
      </div>
      <Field
        name="modelInfo"
        label="Model info"
        defaultValue={values.modelInfo}
        maxLength={300}
        placeholder={"The model is 6'1, wearing size L."}
        hint="Shown on the product page when set."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Field name="seoTitle" label="SEO title" defaultValue={values.seoTitle} maxLength={200} />
        <Field
          name="seoDescription"
          label="SEO description"
          defaultValue={values.seoDescription}
          maxLength={400}
        />
      </div>
    </>
  );
}
