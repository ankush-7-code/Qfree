import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';
import { initRealtime } from './realtime/io.js';
import { closeStaleQueues, expireStaleBookings } from './modules/queues/queue.service.js';

const app = createApp();
const server = createServer(app);
initRealtime(server);

async function housekeeping() {
  try {
    const closed = await closeStaleQueues();
    if (closed) logger.info({ closed }, 'closed queues from previous sessions');
    const expired = await expireStaleBookings();
    if (expired) logger.info({ expired }, 'expired bookings for sessions that did not open');
  } catch (err) {
    logger.error({ err }, 'housekeeping failed');
  }
}

server.listen(env.PORT, () => {
  logger.info(`QFree API listening on http://localhost:${env.PORT} (docs: /api/docs)`);
  void housekeeping();
});
const timer = setInterval(housekeeping, env.HOUSEKEEPING_INTERVAL_MS);

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  clearInterval(timer);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
