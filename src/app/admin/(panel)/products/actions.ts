'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { runAction, type ActionState } from '@/lib/action-result';
import { noticeHref } from '@/lib/admin/notices';
import { AppError } from '@/lib/errors';
import { parseRupees } from '@/lib/rupees';
import { resolveStaffFor } from '@/lib/staff-context';
import {
  addVariant,
  createCategoryAdmin,
  createCollectionAdmin,
  createProductAdmin,
  deleteCategoryAdmin,
  deleteCollectionAdmin,
  deleteProduct,
  getProductAdmin,
  removeProductMedia,
  reorderProductMedia,
  s3StorageFromEnv,
  setProductCollections,
  setProductStatus,
  setVariantActive,
  updateCategoryAdmin,
  updateCollectionAdmin,
  updateMediaAlt,
  updateProduct,
  updateVariant,
  type ProductStatus,
} from '@/modules/catalog';
import { adjustStockAdmin, setLowStockThresholdAdmin } from '@/modules/inventory';

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** Rupee text field to paise, or a field error. Blank is allowed when `optional`. */
function paiseField(
  form: FormData,
  key: string,
  label: string,
  optional = false,
): number | undefined {
  const raw = text(form, key);
  if (!raw && optional) return undefined;
  const paise = parseRupees(raw);
  if (paise === null) {
    const message = `${label}: enter an amount in rupees, for example 1499 or 1499.50`;
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: { [key]: message } });
  }
  return paise;
}

function intField(form: FormData, key: string, label: string): number {
  const raw = text(form, key);
  if (!/^-?\d{1,9}$/.test(raw)) {
    const message = `${label}: enter a whole number`;
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: { [key]: message } });
  }
  return Number(raw);
}

function productFields(form: FormData) {
  return {
    name: text(form, 'name'),
    slug: text(form, 'slug'),
    description: text(form, 'description'),
    categoryId: text(form, 'categoryId'),
    hsnCode: text(form, 'hsnCode'),
    taxRuleId: text(form, 'taxRuleId'),
    materials: text(form, 'materials'),
    careGuide: text(form, 'careGuide'),
    shippingReturns: text(form, 'shippingReturns'),
    modelInfo: text(form, 'modelInfo'),
    seoTitle: text(form, 'seoTitle'),
    seoDescription: text(form, 'seoDescription'),
  };
}

/** Option values come from fields named opt_<Name>; blanks are dropped. */
function optionValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('opt_') && typeof value === 'string' && value.trim()) {
      out[key.slice(4)] = value.trim();
    }
  }
  return out;
}

const productPath = (id: string) => `/admin/products/${id}`;

export async function createProductAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  let productId = '';
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    const created = await createProductAdmin(getDb(), admin, {
      ...productFields(form),
      variants: [
        {
          sku: text(form, 'sku'),
          optionValues: optionValues(form),
          pricePaise: paiseField(form, 'pricePaise', 'Price')!,
          compareAtPaise: paiseField(form, 'compareAtPaise', 'Compare-at price', true),
          stock: intField(form, 'stock', 'Opening stock'),
        },
      ],
    });
    productId = created.productId;
  }, form);
  if (!result.ok) return result;
  revalidatePath('/admin/products');
  redirect(noticeHref(productPath(productId), 'product-created'));
}

export async function updateProductAction(
  productId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await updateProduct(getDb(), admin, productId, productFields(form));
    return 'Product details saved.';
  }, form);
  if (result.ok) {
    revalidatePath(productPath(productId));
    revalidatePath('/admin/products');
  }
  return result;
}

export async function setStatusAction(
  productId: string,
  status: ProductStatus,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await setProductStatus(getDb(), admin, productId, status);
    return status === 'published'
      ? 'Product published. It is now visible in the shop.'
      : status === 'archived'
        ? 'Product archived and hidden from the shop.'
        : 'Product unpublished and hidden from the shop.';
  });
  if (result.ok) {
    revalidatePath(productPath(productId));
    revalidatePath('/admin/products');
  }
  return result;
}

export async function deleteProductAction(productId: string): Promise<ActionState> {
  let mode: 'deleted' | 'archived' = 'deleted';
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    mode = (await deleteProduct(getDb(), admin, productId)).mode;
  });
  if (!result.ok) return result;
  revalidatePath('/admin/products');
  redirect(
    noticeHref('/admin/products', mode === 'deleted' ? 'product-deleted' : 'product-archived'),
  );
}

export async function addVariantAction(
  productId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await addVariant(getDb(), admin, productId, {
      sku: text(form, 'sku'),
      optionValues: optionValues(form),
      pricePaise: paiseField(form, 'pricePaise', 'Price')!,
      compareAtPaise: paiseField(form, 'compareAtPaise', 'Compare-at price', true),
      stock: intField(form, 'stock', 'Opening stock'),
    });
    return 'Variant added.';
  }, form);
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

export async function updateVariantAction(
  productId: string,
  variantId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await updateVariant(getDb(), admin, variantId, {
      sku: text(form, 'sku'),
      optionValues: optionValues(form),
      pricePaise: paiseField(form, 'pricePaise', 'Price')!,
      compareAtPaise: paiseField(form, 'compareAtPaise', 'Compare-at price', true),
    });
    return 'Variant saved.';
  }, form);
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

export async function setVariantActiveAction(
  productId: string,
  variantId: string,
  active: boolean,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await setVariantActive(getDb(), admin, variantId, active);
    return active ? 'Variant reactivated.' : 'Variant deactivated and hidden from the shop.';
  });
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

/** Stock adjustment from the product page (the inventory screen uses the same module function). */
export async function adjustStockAction(
  variantId: string,
  revalidate: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('inventory.edit');
    const r = await adjustStockAdmin(getDb(), admin, {
      variantId,
      delta: intField(form, 'delta', 'Change'),
      reason: text(form, 'reason') === 'correction' ? 'correction' : 'adjustment',
      note: text(form, 'note'),
    });
    return `Stock updated: ${r.onHand} on hand, ${r.available} available.`;
  }, form);
  if (result.ok) {
    revalidatePath(revalidate);
    revalidatePath('/admin/inventory');
  }
  return result;
}

export async function setThresholdAction(
  variantId: string,
  revalidate: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('inventory.edit');
    await setLowStockThresholdAdmin(getDb(), admin, {
      variantId,
      threshold: intField(form, 'threshold', 'Threshold'),
    });
    return 'Low-stock threshold saved.';
  }, form);
  if (result.ok) {
    revalidatePath(revalidate);
    revalidatePath('/admin/inventory');
  }
  return result;
}

export async function updateAltAction(
  productId: string,
  mediaId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await updateMediaAlt(getDb(), admin, mediaId, text(form, 'alt'));
    return 'Alt text saved.';
  }, form);
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

export async function removeMediaAction(productId: string, mediaId: string): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    let storage = null;
    try {
      storage = s3StorageFromEnv();
    } catch {
      // Storage not configured: the database row is still removed; the object stays until cleaned up.
    }
    await removeProductMedia(getDb(), admin, storage, mediaId);
    return 'Image removed.';
  });
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

/** Move an image one place earlier or later (keyboard-friendly alternative to drag and drop). */
export async function moveMediaAction(
  productId: string,
  mediaId: string,
  direction: 'up' | 'down',
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    const detail = await getProductAdmin(getDb(), admin, productId);
    if (!detail) throw new AppError('NOT_FOUND', 'Product not found.');
    const ids = detail.media.map((m) => m.id);
    const i = ids.indexOf(mediaId);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await reorderProductMedia(getDb(), admin, productId, ids);
    return 'Image order saved.';
  });
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

export async function setCollectionsAction(
  productId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    const ids = form.getAll('collectionId').map(String);
    await setProductCollections(getDb(), admin, productId, ids);
    return 'Collections saved.';
  }, form);
  if (result.ok) revalidatePath(productPath(productId));
  return result;
}

// ---- categories and collections (products/categories page) ---------------------------------------

const taxonomyPath = '/admin/products/categories';

function categoryFields(form: FormData) {
  return {
    name: text(form, 'name'),
    slug: text(form, 'slug'),
    parentId: text(form, 'parentId'),
    position: Number(text(form, 'position') || '0'),
  };
}

export async function createCategoryAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await createCategoryAdmin(getDb(), admin, categoryFields(form));
    return 'Category created.';
  }, form);
  if (result.ok) revalidatePath(taxonomyPath);
  return result;
}

export async function updateCategoryAction(
  categoryId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await updateCategoryAdmin(getDb(), admin, categoryId, categoryFields(form));
    return 'Category saved.';
  }, form);
  if (result.ok) revalidatePath(taxonomyPath);
  return result;
}

export async function deleteCategoryAction(categoryId: string): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    const r = await deleteCategoryAdmin(getDb(), admin, categoryId);
    return `Category deleted. ${r.productsUncategorised} product(s) are now uncategorised.`;
  });
  if (result.ok) revalidatePath(taxonomyPath);
  return result;
}

function collectionFields(form: FormData) {
  return {
    name: text(form, 'name'),
    slug: text(form, 'slug'),
    description: text(form, 'description'),
    position: Number(text(form, 'position') || '0'),
    published: form.get('published') === 'on',
  };
}

export async function createCollectionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await createCollectionAdmin(getDb(), admin, collectionFields(form));
    return 'Collection created.';
  }, form);
  if (result.ok) revalidatePath(taxonomyPath);
  return result;
}

export async function updateCollectionAction(
  collectionId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    await updateCollectionAdmin(getDb(), admin, collectionId, collectionFields(form));
    return 'Collection saved.';
  }, form);
  if (result.ok) revalidatePath(taxonomyPath);
  return result;
}

export async function deleteCollectionAction(collectionId: string): Promise<ActionState> {
  const result = await runAction(async () => {
    const { admin } = await resolveStaffFor('catalog.edit');
    const r = await deleteCollectionAdmin(getDb(), admin, collectionId);
    return `Collection deleted. ${r.membersRemoved} product(s) were removed from it (the products stay).`;
  });
  if (result.ok) revalidatePath(taxonomyPath);
  return result;
}
