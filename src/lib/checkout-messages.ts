import { Money, formatBracketPrice, type QuoteChange } from '@/modules/pricing';

const money = (paise: number) => formatBracketPrice(Money.of(paise));

/** Plain-language lines for what changed since the customer reviewed their order (INV-12). */
export function describeChanges(changes: QuoteChange[]): string[] {
  return changes.map((c) => {
    switch (c.kind) {
      case 'price':
        return `${c.name}: price changed from ${money(c.oldPaise)} to ${money(c.newPaise)}.`;
      case 'stock':
        return `${c.name}: stock changed, please check availability.`;
      case 'removed':
        return `${c.name} is no longer in your bag.`;
      case 'added':
        return `${c.name} was added to your bag.`;
      case 'quantity':
        return `${c.name}: quantity changed from ${c.oldQty} to ${c.newQty}.`;
      case 'shipping':
        return `Shipping changed from ${money(c.oldPaise)} to ${money(c.newPaise)}.`;
      case 'discount':
        return `Discount changed from ${money(c.oldPaise)} to ${money(c.newPaise)}.`;
      case 'total':
        return `The total changed from ${money(c.oldPaise)} to ${money(c.newPaise)}.`;
    }
  });
}
