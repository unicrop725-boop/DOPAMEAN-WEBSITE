p = 'src/modules/checkout/placement.ts'
s = open(p).read()
s = s.replace("quoteToken: z.string().min(10).max(20_000),", "quoteToken: z.string().min(1).max(20_000),")
old = """  if (quote.lines.length === 0) throw new AppError('CART_EMPTY');
  if (cq.removedVariantIds.length > 0) {
    throw new AppError('PRODUCT_UNAVAILABLE', 'some items are no longer available', {
      variantIds: cq.removedVariantIds,
    });
  }
"""
new = """  // Items that are no longer sold take priority over "empty": the customer must be told why they vanished.
  if (cq.removedVariantIds.length > 0) {
    throw new AppError('PRODUCT_UNAVAILABLE', 'some items are no longer available', {
      variantIds: cq.removedVariantIds,
    });
  }
  if (quote.lines.length === 0) throw new AppError('CART_EMPTY');
"""
assert old in s, 'placement block not found'
s = s.replace(old, new)
open(p, 'w').write(s)

p = 'tests/support/shop.ts'
s = open(p).read()
s = s.replace("shirt: await make('oxford-shirt', 'Oxford Shirt', 149_900, ['S', 'M', 'L'], 5),", "shirt: await make('oxford-shirt', 'Oxford Shirt', 149_900, ['S', 'M', 'L'], 60),")
s = s.replace("tee: await make('boxy-tee', 'Boxy Tee', 79_900, ['M'], 5),", "tee: await make('boxy-tee', 'Boxy Tee', 79_900, ['M'], 60),")
s = s.replace("A small catalog: a Rs 1,499 shirt (5 each of S/M/L), a Rs 799 tee and a single-unit scarf.", "A small catalog: a Rs 1,499 shirt (60 each of S/M/L), a Rs 799 tee (60) and a single-unit scarf.")
open(p, 'w').write(s)

p = 'tests/integration/checkout/placement.test.ts'
s = open(p).read()
old = """    await t.db.update(product).set({ status: 'draft' }).where(eq(product.id, shop.tee.productId));
    await expectCode(placeOrder(deps, owner, null, input), 'PRODUCT_UNAVAILABLE');
    await t.db.update(product).set({ status: 'published' }).where(eq(product.id, shop.tee.productId));"""
new = """    await t.db.update(product).set({ status: 'draft' }).where(eq(product.id, shop.tee.productId));
    try {
      await expectCode(placeOrder(deps, owner, null, input), 'PRODUCT_UNAVAILABLE');
    } finally {
      await t.db.update(product).set({ status: 'published' }).where(eq(product.id, shop.tee.productId));
    }"""
assert old in s
s = s.replace(old, new)
open(p, 'w').write(s)
print('ok')
