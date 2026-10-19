import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A drizzle transaction handle or the root db: anything that can run queries. */
export type DbOrTx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

let pool: Pool | undefined;
let db: Db | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
  }
  return pool;
}

export function getDb(): Db {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
