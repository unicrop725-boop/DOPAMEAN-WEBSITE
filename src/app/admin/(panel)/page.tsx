import { getDb } from '@/db/client';
import { countProductsByStatus } from '@/modules/catalog';
import { countLowStock } from '@/modules/inventory';

export const metadata = { title: 'Dashboard' };

export default async function Dashboard() {
  const db = getDb();
  const [products, lowStock] = await Promise.all([countProductsByStatus(db), countLowStock(db)]);
  const tiles = [
    { label: 'Published products', value: products.published },
    { label: 'Draft products', value: products.draft },
    { label: 'Archived products', value: products.archived },
    { label: 'Low-stock variants', value: lowStock },
  ];
  return (
    <section aria-labelledby="dash">
      <h1 id="dash" className="mb-4 font-mono text-lg uppercase">
        Dashboard
      </h1>
      <dl className="grid grid-cols-2 gap-px border border-line bg-line md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="bg-paper p-4">
            <dt className="font-mono text-xs uppercase text-muted">{t.label}</dt>
            <dd className="mt-2 font-mono text-2xl">{t.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
