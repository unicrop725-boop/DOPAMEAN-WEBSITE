import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { E2E_DB, E2E_PORT, OWNER, PG_ADMIN_URL, appEnv } from './env';

const children: ChildProcess[] = [];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${r.status}`);
}

async function waitFor(url: string, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Fresh dedicated database -> migrate from empty -> seed -> bootstrap owner -> start the production
 * build of the web app and the worker as real processes (no mocks).
 * Requires `npm run build` first and Postgres + Mailpit reachable (docker compose up -d postgres mailpit).
 */
export default async function globalSetup() {
  const admin = new Pool({ connectionString: PG_ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB}`);
  await admin.end();

  const env = appEnv();
  run('npx', ['tsx', 'scripts/migrate.ts'], env);
  run('npx', ['tsx', 'scripts/seed.ts'], env);
  // Test-only: rows that reproduce the original pages' content for the visual-parity suite.
  run('npx', ['tsx', 'scripts/seed-parity.ts'], env);
  run('npx', ['tsx', 'scripts/create-owner.ts'], {
    ...env,
    OWNER_EMAIL: OWNER.email,
    OWNER_NAME: OWNER.name,
    OWNER_PASSWORD: OWNER.password,
  });

  const web = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-p', String(E2E_PORT)],
    {
      env,
      stdio: 'inherit',
    },
  );
  const worker = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/index.ts'], {
    env,
    stdio: 'inherit',
  });
  children.push(web, worker);

  try {
    await waitFor(`http://localhost:${E2E_PORT}/api/health`);
  } catch (err) {
    for (const c of children) c.kill();
    throw err;
  }

  return async () => {
    for (const c of children) c.kill();
  };
}
