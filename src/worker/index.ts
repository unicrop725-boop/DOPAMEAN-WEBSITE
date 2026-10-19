import { PgBoss } from 'pg-boss';
import { closeDb, getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { baseLogger } from '@/lib/logger';
import { relayOutbox } from '@/lib/outbox';
import { mailerFromEnv, notificationHandlers } from '@/modules/notifications';
import { housekeeping, writeHeartbeat } from './jobs';

process.env.SERVICE_NAME ??= 'worker';
const log = baseLogger;

const HOUSEKEEPING_QUEUE = 'housekeeping';
const OUTBOX_POLL_MS = 2_000;
const HEARTBEAT_MS = 10_000;

async function main() {
  const env = getEnv();
  const db = getDb();
  const handlers = { ...notificationHandlers(mailerFromEnv()) };

  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();

  await boss.createQueue(HOUSEKEEPING_QUEUE);
  await boss.schedule(HOUSEKEEPING_QUEUE, '*/10 * * * *');
  await boss.work(HOUSEKEEPING_QUEUE, async () => {
    const result = await housekeeping(db);
    log.info(result, 'housekeeping done');
  });

  // The outbox relay polls Postgres directly (pg-boss cron granularity is one minute).
  let stopping = false;
  let relaying = false;
  const relayTimer = setInterval(async () => {
    if (relaying || stopping) return;
    relaying = true;
    try {
      const n = await relayOutbox(db, handlers, log);
      if (n > 0) log.info({ delivered: n }, 'outbox relayed');
    } catch (err) {
      log.error({ err }, 'outbox relay failed');
    } finally {
      relaying = false;
    }
  }, OUTBOX_POLL_MS);

  const beat = () => writeHeartbeat(db).catch((err) => log.error({ err }, 'heartbeat failed'));
  await beat();
  const beatTimer = setInterval(beat, HEARTBEAT_MS);

  log.info('worker started');

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker stopping');
    clearInterval(relayTimer);
    clearInterval(beatTimer);
    await boss.stop({ graceful: true, timeout: 10_000 });
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'worker crashed');
  process.exit(1);
});
