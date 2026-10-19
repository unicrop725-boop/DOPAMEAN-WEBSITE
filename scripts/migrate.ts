import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from '../src/db/client';

// Applies SQL migrations from ./drizzle. Safe to run repeatedly; never drops data.
async function main() {
  await migrate(getDb(), { migrationsFolder: './drizzle' });
  console.log('migrations applied');
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
