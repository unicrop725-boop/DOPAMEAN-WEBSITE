import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts ONE real PostgreSQL (Testcontainers) for the whole run and migrates a template database from
 * empty using the committed SQL migrations. That doubles as the "migrations from empty DB" gate.
 * Set TEST_DATABASE_ADMIN_URL to reuse an existing server (CI service container) instead.
 */
export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    adminUrl = container.getConnectionUri();
  }
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query('DROP DATABASE IF EXISTS tpl');
  await admin.query('CREATE DATABASE tpl');
  await admin.end();

  const tplUrl = withDb(adminUrl, 'tpl');
  const pool = new Pool({ connectionString: tplUrl });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();

  project.provide('pgAdminUrl', adminUrl);
  return async () => {
    await container?.stop();
  };
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
