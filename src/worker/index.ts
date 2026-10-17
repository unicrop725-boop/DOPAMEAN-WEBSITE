import { PgBoss } from 'pg-boss';
import { closeDb, getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { baseLogger } from '@/lib/logger';
import { relayOutbox } from '@/lib/outbox';
import { buildCheckoutDeps } from '@/lib/checkout-deps-core';
import {
  cancelUnpaidOrdersJob,
  expireReservationsJob,
  reconcilePendingPayments,
  retryStuckRefundsJob,
  type CheckoutDeps,
} from '@/modules/checkout';
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

  // Commerce jobs (SPEC sections 4.5 and 7): release expired stock holds, cancel unpaid orders after their deadline,
  // reconcile payments stuck in pending, retry refunds that never got an answer.
  const commerceJobs: {
    name: string;
    cron: string;
    run: (deps: CheckoutDeps) => Promise<unknown>;
  }[] = [
    { name: 'expire-reservations', cron: '* * * * *', run: expireReservationsJob },
    { name: 'cancel-unpaid-orders', cron: '*/5 * * * *', run: cancelUnpaidOrdersJob },
    { name: 'reconcile-payments', cron: '*/10 * * * *', run: reconcilePendingPayments },
    { name: 'retry-refunds', cron: '*/5 * * * *', run: retryStuckRefundsJob },
  ];
  for (const job of commerceJobs) {
    await boss.createQueue(job.name);
    await boss.schedule(job.name, job.cron);
    await boss.work(job.name, async () => {
      try {
        const result = await job.run(await buildCheckoutDeps());
        log.info({ job: job.name, result }, 'job done');
      } catch (err) {
        log.error({ err, job: job.name }, 'job failed');
        throw err;
      }
    });
  }

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
