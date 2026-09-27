import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildEntryView, buildSnapshot, buildStaffView, loadQueueState } from '../modules/queues/queue.state.js';
import { getIO, rooms } from './io.js';

/**
 * Push the latest state of a queue to everyone concerned, from a single DB read:
 * public watchers, staff, the organization dashboard and each patient in the queue.
 */
export async function publishQueue(queueId: string) {
  const io = getIO();
  if (!io) return;
  try {
    const state = await loadQueueState(prisma, queueId);
    const snapshot = buildSnapshot(state);
    io.to(rooms.queue(queueId)).emit('queue:snapshot', snapshot);
    io.to(rooms.org(state.queue.organization.id)).emit('org:queue', snapshot);
    io.to(rooms.queueStaff(queueId)).emit('queue:staff', buildStaffView(state));

    for (const entry of state.entries) {
      // Everyone still in line, plus anyone whose entry changed in the last minute (so they see "done"/"skipped").
      const recent = Date.now() - entry.updatedAt.getTime() < 60_000;
      if (entry.status === 'WAITING' || entry.status === 'SERVING' || recent) {
        io.to(rooms.user(entry.patient.userId)).emit('queue:entry', buildEntryView(state, entry));
      }
    }
  } catch (err) {
    logger.error({ err, queueId }, 'failed to publish queue update');
  }
}
