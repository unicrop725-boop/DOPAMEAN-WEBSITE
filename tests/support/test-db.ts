import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { inject } from 'vitest';
import * as schema from '../../src/db/schema';
import type { Db } from '../../src/db/client';

export type TestDb = { db: Db; pool: Pool; url: string; name: string; close: () => Promise<void> };

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** A fresh, fully migrated database (cloned from the migrated template) with its own pool. */
export async function newTestDb(maxConnections = 30): Promise<TestDb> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE ${name} TEMPLATE tpl`);
  await admin.end();

  const url = withDb(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: maxConnections });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    url,
    name,
    close: async () => {
      await pool.end();
      const a = new Pool({ connectionString: adminUrl });
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Drizzle wraps driver errors; the Postgres message is on `cause`. Assert against either. */
export async function expectDbError(promise: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let failure: { message?: string; cause?: { message?: string } } | undefined;
  try {
    await promise;
  } catch (err) {
    failure = err as typeof failure;
  }
  if (!failure)
    throw new Error(`expected a database error matching ${pattern}, but the query succeeded`);
  const text = `${failure.message ?? ''} ${failure.cause?.message ?? ''}`;
  if (!pattern.test(text)) throw new Error(`database error did not match ${pattern}: ${text}`);
}
