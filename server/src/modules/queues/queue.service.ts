/**
 * Queue state machine. Every mutation runs in a transaction that first takes a row
 * lock on the queue (SELECT … FOR UPDATE), so token numbers, ordering and the single
 * "serving" slot stay consistent under concurrent requests. Notifications and socket
 * broadcasts are collected during the transaction and only sent after it commits.
 *
 *   BOOKED (future date) ──that day's session opens──▶ WAITING
 *   WAITING ──call──▶ SERVING "Called" ──complete/next──▶ COMPLETED
 *      │                 │
 *      │ leave/cancel    └──not present──▶ SKIPPED "Missed" ──recall (doctor decides)──▶ SERVING "Recalled"
 *      ▼                                       │
 *   CANCELLED                                  └──no-show / queue closes──▶ NO_SHOW
 *
 * Missed patients are never slotted back into the line, so the active queue is not disturbed.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { EntrySource, Priority, QueueEventType } from '../../generated/prisma/client.js';
import { prisma, type Tx } from '../../lib/prisma.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isWithinHours, localParts } from '../../lib/time.js';
import { getSettings } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { publishQueue } from '../../realtime/publish.js';
import { sendNotifications, type NotificationInput } from '../notifications/notification.service.js';
import {
  bookableDates,
  dayAvailability,
  estimatedTimeForPosition,
  estimateWaitSeconds,
  formatToken,
  JOIN_BLOCK_MESSAGE,
  nextAverage,
  orderWaiting,
  sameDayJoinBlock,
  sortKeyForToken,
  toMinutes,
  weekdayOf,
  type JoinBlock,
  type PriorityLevel,
} from './queue.logic.js';
import { effectiveStatus, getMyEntry, isSessionCurrent, loadQueue, todayFor, type LoadedQueue } from './queue.state.js';

export const SYSTEM_ACTOR = null;
type ActorId = string | null;

class Effects {
  notifications: NotificationInput[] = [];
  notify(n: NotificationInput) {
    this.notifications.push(n);
  }
}

function providerLabel(q: LoadedQueue) {
  return q.doctor ? `Dr. ${q.doctor.user.fullName.replace(/^Dr\.?\s*/i, '')}` : q.service?.name ?? q.name;
}

/** Run `fn` holding an exclusive lock on the queue row, then deliver side effects. */
async function withQueue<T>(queueId: string, fn: (tx: Tx, queue: LoadedQueue, fx: Effects) => Promise<T>): Promise<T> {
  const fx = new Effects();
  const result = await prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM queues WHERE id = ${queueId}::uuid FOR UPDATE`;
      if (!locked.length) throw notFound('Queue');
      const queue = await loadQueue(tx, queueId);
      return fn(tx, queue, fx);
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
  await sendNotifications(fx.notifications);
  await publishQueue(queueId);
  return result;
}

function recordEvent(
  tx: Tx,
  queueId: string,
  type: QueueEventType,
  opts: { entryId?: string; actorId?: ActorId; meta?: Record<string, unknown> } = {},
) {
  return tx.queueEvent.create({
    data: { queueId, type, entryId: opts.entryId, actorId: opts.actorId ?? null, meta: opts.meta as object | undefined },
  });
}

async function sessionEntries(tx: Tx, queue: LoadedQueue) {
  if (!isSessionCurrent(queue)) return [];
  return tx.queueEntry.findMany({
    where: { queueId: queue.id, sessionDate: queue.sessionDate! },
    include: { patient: { select: { userId: true } } },
  });
}

async function orderedWaiting(tx: Tx, queue: LoadedQueue) {
  const entries = await sessionEntries(tx, queue);
  return {
    entries,
    serving: entries.find((e) => e.status === 'SERVING') ?? null,
    waiting: orderWaiting(entries.filter((e) => e.status === 'WAITING').map((e) => ({ ...e, priority: e.priority as PriorityLevel }))),
  };
}

/** Notify waiting patients who have just come within `approachingThreshold` places of the front. */
async function notifyApproaching(tx: Tx, queue: LoadedQueue, fx: Effects) {
  const { waiting, serving } = await orderedWaiting(tx, queue);
  const due = waiting.slice(0, queue.approachingThreshold + 1).filter((e) => !e.approachingNotified);
  if (!due.length) return;
  await tx.queueEntry.updateMany({ where: { id: { in: due.map((e) => e.id) } }, data: { approachingNotified: true } });
  for (const e of due) {
    const ahead = waiting.findIndex((w) => w.id === e.id);
    const mins = toMinutes(estimateWaitSeconds(ahead, queue.avgServiceSeconds, serving?.calledAt ?? null));
    fx.notify({
      userId: e.patient.userId,
      type: 'TURN_APPROACHING',
      title: 'Your turn is approaching',
      body:
        ahead === 0
          ? `You are next for ${providerLabel(queue)} (token ${e.tokenLabel}). Please be ready.`
          : `${ahead} patient${ahead > 1 ? 's' : ''} ahead of you for ${providerLabel(queue)} (token ${e.tokenLabel}), about ${mins} min.`,
      data: { queueId: queue.id, entryId: e.id },
    });
  }
}

/** End-of-session cleanup: waiting → cancelled, serving → completed, skipped → no-show. */
async function finalizeSession(tx: Tx, queue: LoadedQueue, fx: Effects, actorId: ActorId, reason: string) {
  const active = await tx.queueEntry.findMany({
    where: { queueId: queue.id, status: { in: ['WAITING', 'SERVING', 'SKIPPED'] } },
    include: { patient: { select: { userId: true } } },
  });
  const now = new Date();
  for (const e of active) {
    if (e.status === 'WAITING') {
      await tx.queueEntry.update({ where: { id: e.id }, data: { status: 'CANCELLED', cancelledAt: now, note: reason } });
      await recordEvent(tx, queue.id, 'CANCELLED', { entryId: e.id, actorId, meta: { reason } });
      fx.notify({
        userId: e.patient.userId,
        type: 'QUEUE_CLOSED',
        title: 'Queue closed',
        body: `${providerLabel(queue)}'s queue has closed for today. Your token ${e.tokenLabel} was cancelled.`,
        data: { queueId: queue.id, entryId: e.id },
      });
    } else if (e.status === 'SERVING') {
      await tx.queueEntry.update({ where: { id: e.id }, data: { status: 'COMPLETED', completedAt: now } });
      await recordEvent(tx, queue.id, 'COMPLETED', { entryId: e.id, actorId, meta: { reason } });
    } else {
      await tx.queueEntry.update({ where: { id: e.id }, data: { status: 'NO_SHOW' } });
      await recordEvent(tx, queue.id, 'NO_SHOW', { entryId: e.id, actorId, meta: { reason } });
    }
  }
}

async function completeServing(tx: Tx, queue: LoadedQueue, actorId: ActorId) {
  const serving = await tx.queueEntry.findFirst({ where: { queueId: queue.id, status: 'SERVING' } });
  if (!serving) return null;
  const now = new Date();
  await tx.queueEntry.update({ where: { id: serving.id }, data: { status: 'COMPLETED', completedAt: now } });
  const seconds = serving.calledAt ? (now.getTime() - serving.calledAt.getTime()) / 1000 : null;
  if (seconds !== null) {
    const avg = nextAverage(queue.avgServiceSeconds, seconds);
    await tx.queue.update({ where: { id: queue.id }, data: { avgServiceSeconds: avg } });
    queue.avgServiceSeconds = avg;
  }
  await recordEvent(tx, queue.id, 'COMPLETED', { entryId: serving.id, actorId, meta: { durationSeconds: seconds && Math.round(seconds) } });
  return serving;
}

function requireActiveSession(queue: LoadedQueue, allowPaused = false) {
  const status = effectiveStatus(queue);
  if (status === 'CLOSED') throw conflict('This queue is closed', 'QUEUE_CLOSED');
  if (status === 'PAUSED' && !allowPaused) throw conflict('The queue is paused. Resume it first.', 'QUEUE_PAUSED');
}

/** Tokens issued for a day (bookings, same-day and reception), excluding cancelled ones. */
const issuedFor = (tx: Tx, queueId: string, sessionDate: string) =>
  tx.queueEntry.count({ where: { queueId, sessionDate, status: { not: 'CANCELLED' } } });

const BLOCK_CODE: Record<JoinBlock, string> = {
  QUEUE_CLOSED: 'QUEUE_CLOSED',
  ORG_INACTIVE: 'ORG_INACTIVE',
  DOCTOR_UNAVAILABLE: 'DOCTOR_UNAVAILABLE',
  STOPPED_BY_DOCTOR: 'JOINS_STOPPED',
  FULL: 'QUEUE_FULL',
  CUTOFF_PASSED: 'CUTOFF_PASSED',
  SAME_DAY_DISABLED: 'SAME_DAY_DISABLED',
};
const joinBlocked = (block: JoinBlock) => conflict(JOIN_BLOCK_MESSAGE[block], BLOCK_CODE[block]);

/** Next token of the current session for a patient; a new NORMAL entry always goes to the back. */
async function issueToken(tx: Tx, queue: LoadedQueue, patientId: string, source: EntrySource, note?: string) {
  const { lastTokenNumber: tokenNumber } = await tx.queue.update({
    where: { id: queue.id },
    data: { lastTokenNumber: { increment: 1 } },
    select: { lastTokenNumber: true },
  });
  const { waiting, serving } = await orderedWaiting(tx, queue);
  const ahead = waiting.length;
  const entry = await tx.queueEntry.create({
    data: {
      queueId: queue.id,
      patientId,
      sessionDate: queue.sessionDate!,
      tokenNumber,
      tokenLabel: formatToken(queue.tokenPrefix, tokenNumber),
      sortKey: sortKeyForToken(tokenNumber),
      source,
      note,
      approachingNotified: ahead <= queue.approachingThreshold,
    },
  });
  return { entry, ahead, serving };
}

async function entryInQueue(tx: Tx, queueId: string, entryId: string) {
  const entry = await tx.queueEntry.findUnique({ where: { id: entryId }, include: { patient: { select: { userId: true } } } });
  if (!entry || entry.queueId !== queueId) throw notFound('Queue entry');
  return entry;
}

// ─────────────────────────── Lifecycle ───────────────────────────

export async function openQueue(queueId: string, actorId: ActorId, opts: { override?: boolean; actorIsDoctor?: boolean } = {}) {
  const settings = await getSettings();
  return withQueue(queueId, async (tx, queue, fx) => {
    if (!queue.organization.isActive) throw conflict('This organization is currently inactive', 'ORG_INACTIVE');
    const current = isSessionCurrent(queue);
    if (current && queue.status === 'OPEN') return { status: 'OPEN' as const };

    const withinHours = isWithinHours(queue.organization.hours, queue.organization.timezone);
    if (settings.enforceOperatingHours && !withinHours && !opts.override) {
      throw new AppError(409, 'OUTSIDE_HOURS', 'The organization is outside its operating hours. Confirm to open anyway.');
    }
    if (queue.doctor && !queue.doctor.isAvailable) {
      if (!opts.actorIsDoctor) throw conflict('The doctor is marked unavailable', 'DOCTOR_UNAVAILABLE');
      await tx.doctor.update({ where: { id: queue.doctor.id }, data: { isAvailable: true } });
    }

    if (!current) {
      // New day: close out anything left over, then start today's line with the advance bookings
      // (in token order); on-the-spot patients get the numbers after the last booked token.
      await finalizeSession(tx, queue, fx, actorId, 'Session ended');
      const today = todayFor(queue);
      const booked = await tx.queueEntry.findMany({
        where: { queueId: queue.id, sessionDate: today, status: 'BOOKED' },
        include: { patient: { select: { userId: true } } },
      });
      if (booked.length) {
        await tx.queueEntry.updateMany({ where: { id: { in: booked.map((b) => b.id) } }, data: { status: 'WAITING' } });
        for (const b of booked) {
          fx.notify({
            userId: b.patient.userId,
            type: 'QUEUE_OPENED',
            title: `Today's queue is open — ${b.tokenLabel}`,
            body: `${providerLabel(queue)} has started. Follow your position live in QFree.`,
            data: { queueId: queue.id, entryId: b.id },
          });
        }
      }
      const { _max } = await tx.queueEntry.aggregate({ where: { queueId: queue.id, sessionDate: today }, _max: { tokenNumber: true } });
      await tx.queue.update({
        where: { id: queue.id },
        data: { sessionDate: today, lastTokenNumber: _max.tokenNumber ?? 0, joinsStopped: false, joinsReopened: false },
      });
    }
    const wasPaused = current && queue.status === 'PAUSED';
    await tx.queue.update({
      where: { id: queue.id },
      data: { status: 'OPEN', pausedAt: null, closedAt: null, ...(wasPaused ? {} : { openedAt: new Date() }) },
    });
    await recordEvent(tx, queue.id, wasPaused ? 'RESUMED' : 'OPENED', {
      actorId,
      meta: { outsideHours: !withinHours, override: !!opts.override },
    });
    if (!withinHours) {
      await audit({ actorId, action: 'queue.open_outside_hours', entityType: 'queue', entityId: queue.id }, tx);
    }
    return { status: 'OPEN' as const };
  });
}

export async function pauseQueue(queueId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue, fx) => {
    requireActiveSession(queue);
    await tx.queue.update({ where: { id: queue.id }, data: { status: 'PAUSED', pausedAt: new Date() } });
    await recordEvent(tx, queue.id, 'PAUSED', { actorId });
    const { waiting } = await orderedWaiting(tx, queue);
    for (const e of waiting) {
      fx.notify({
        userId: e.patient.userId,
        type: 'QUEUE_PAUSED',
        title: 'Queue paused',
        body: `${providerLabel(queue)} has paused the queue for a short while. Your place (${e.tokenLabel}) is kept.`,
        data: { queueId: queue.id, entryId: e.id },
      });
    }
    return { status: 'PAUSED' as const };
  });
}

export async function resumeQueue(queueId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue, fx) => {
    if (effectiveStatus(queue) !== 'PAUSED') throw conflict('The queue is not paused', 'QUEUE_NOT_PAUSED');
    await tx.queue.update({ where: { id: queue.id }, data: { status: 'OPEN', pausedAt: null } });
    await recordEvent(tx, queue.id, 'RESUMED', { actorId });
    const { waiting } = await orderedWaiting(tx, queue);
    for (const e of waiting) {
      fx.notify({
        userId: e.patient.userId,
        type: 'QUEUE_RESUMED',
        title: 'Queue resumed',
        body: `${providerLabel(queue)}'s queue is moving again.`,
        data: { queueId: queue.id, entryId: e.id },
      });
    }
    return { status: 'OPEN' as const };
  });
}

export async function closeQueue(queueId: string, actorId: ActorId, reason = 'Queue closed') {
  return withQueue(queueId, async (tx, queue, fx) => {
    if (queue.status === 'CLOSED') return { status: 'CLOSED' as const };
    await finalizeSession(tx, queue, fx, actorId, reason);
    await tx.queue.update({ where: { id: queue.id }, data: { status: 'CLOSED', closedAt: new Date(), pausedAt: null } });
    await recordEvent(tx, queue.id, 'CLOSED', { actorId, meta: { reason } });
    return { status: 'CLOSED' as const };
  });
}

// ─────────────────────────── Patient actions ───────────────────────────

export async function joinQueue(queueId: string, userId: string) {
  const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
  if (!patient) throw forbidden('Only patient accounts can join a queue');
  const settings = await getSettings();

  const activeElsewhere = await prisma.queueEntry.count({
    where: { patientId: patient.id, status: { in: ['WAITING', 'SERVING'] }, queueId: { not: queueId } },
  });
  if (activeElsewhere >= settings.maxActiveQueuesPerPatient) {
    throw conflict(`You can be in at most ${settings.maxActiveQueuesPerPatient} queues at once`, 'TOO_MANY_ACTIVE_QUEUES');
  }

  try {
    await withQueue(queueId, async (tx, queue, fx) => {
      requireActiveSession(queue, settings.allowJoinWhilePaused);
      const existing = await tx.queueEntry.findFirst({
        where: { queueId, patientId: patient.id, status: { in: ['WAITING', 'SERVING'] } },
      });
      if (existing) throw conflict(`You are already in this queue with token ${existing.tokenLabel}`, 'ALREADY_IN_QUEUE');

      const block = sameDayJoinBlock({
        status: effectiveStatus(queue),
        orgActive: queue.organization.isActive,
        doctorAvailable: queue.doctor ? queue.doctor.isAvailable : true,
        joinsStopped: queue.joinsStopped,
        joinsReopened: queue.joinsReopened,
        capacity: queue.capacity,
        issued: await issuedFor(tx, queueId, queue.sessionDate!),
        cutoffTime: queue.joinCutoffTime,
        localTime: localParts(queue.organization.timezone).time,
        allowSameDayJoin: queue.allowSameDayJoin,
      });
      if (block) throw joinBlocked(block);

      const { entry, ahead, serving } = await issueToken(tx, queue, patient.id, 'SAME_DAY');
      const tokenLabel = entry.tokenLabel;
      await recordEvent(tx, queueId, 'JOINED', { entryId: entry.id, actorId: userId });
      const mins = toMinutes(estimateWaitSeconds(ahead, queue.avgServiceSeconds, serving?.calledAt ?? null));
      fx.notify({
        userId,
        type: 'QUEUE_JOINED',
        title: `You're in the queue — ${tokenLabel}`,
        body: `${providerLabel(queue)}: ${ahead} patient${ahead === 1 ? '' : 's'} ahead, about ${mins} min wait.`,
        data: { queueId, entryId: entry.id },
      });
    });
  } catch (err) {
    // The partial unique index is the last line of defence against duplicate active entries.
    if ((err as { code?: string }).code === 'P2002') throw conflict('You are already in this queue', 'ALREADY_IN_QUEUE');
    throw err;
  }
  return (await getMyEntry(queueId, userId))!;
}

export async function leaveQueue(queueId: string, userId: string) {
  const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
  if (!patient) throw forbidden('Only patient accounts can leave a queue');
  return withQueue(queueId, async (tx, queue, fx) => {
    const entry = await tx.queueEntry.findFirst({
      where: { queueId, patientId: patient.id, status: { in: ['WAITING', 'SERVING'] } },
    });
    if (!entry) throw notFound('Active queue entry');
    if (entry.status === 'SERVING') throw conflict('You are currently being served and cannot leave the queue', 'BEING_SERVED');
    await tx.queueEntry.update({
      where: { id: entry.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), note: 'Left by patient' },
    });
    await recordEvent(tx, queueId, 'CANCELLED', { entryId: entry.id, actorId: userId, meta: { by: 'patient' } });
    await notifyApproaching(tx, queue, fx);
    return { entryId: entry.id, status: 'CANCELLED' as const };
  });
}

// ─────────────────────────── Staff actions ───────────────────────────

/** Complete the patient being served (if any) and call the next one in order. */
export async function callNext(queueId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue, fx) => {
    requireActiveSession(queue);
    const completed = await completeServing(tx, queue, actorId);
    const { waiting } = await orderedWaiting(tx, queue);
    const next = waiting[0];
    if (!next) return { completed: completed?.tokenLabel ?? null, called: null };

    await tx.queueEntry.update({ where: { id: next.id }, data: { status: 'SERVING', calledAt: new Date() } });
    await recordEvent(tx, queueId, 'CALLED', { entryId: next.id, actorId });
    fx.notify({
      userId: next.patient.userId,
      type: 'YOUR_TURN',
      title: `It's your turn — ${next.tokenLabel}`,
      body: `Please proceed to ${providerLabel(queue)} at ${queue.organization.name} now.`,
      data: { queueId, entryId: next.id },
    });
    await notifyApproaching(tx, queue, fx);
    return { completed: completed?.tokenLabel ?? null, called: next.tokenLabel };
  });
}

/** Mark the current patient as served without calling anyone else. */
export async function completeCurrent(queueId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue) => {
    const done = await completeServing(tx, queue, actorId);
    if (!done) throw conflict('No patient is currently being served', 'NOBODY_SERVING');
    return { completed: done.tokenLabel };
  });
}

/** Call a specific waiting patient out of order (e.g. a skipped patient who has returned). */
export async function callEntry(queueId: string, entryId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue, fx) => {
    requireActiveSession(queue);
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.status !== 'WAITING') throw conflict('Only waiting patients can be called', 'INVALID_STATE');
    const completed = await completeServing(tx, queue, actorId);
    await tx.queueEntry.update({ where: { id: entry.id }, data: { status: 'SERVING', calledAt: new Date() } });
    await recordEvent(tx, queueId, 'CALLED', { entryId, actorId, meta: { outOfOrder: true } });
    fx.notify({
      userId: entry.patient.userId,
      type: 'YOUR_TURN',
      title: `It's your turn — ${entry.tokenLabel}`,
      body: `Please proceed to ${providerLabel(queue)} at ${queue.organization.name} now.`,
      data: { queueId, entryId },
    });
    await notifyApproaching(tx, queue, fx);
    return { completed: completed?.tokenLabel ?? null, called: entry.tokenLabel };
  });
}

export async function skipEntry(queueId: string, entryId: string, actorId: ActorId, reason?: string) {
  return withQueue(queueId, async (tx, queue, fx) => {
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.status !== 'WAITING' && entry.status !== 'SERVING') throw conflict('Only waiting or serving patients can be skipped', 'INVALID_STATE');
    await tx.queueEntry.update({
      where: { id: entry.id },
      data: { status: 'SKIPPED', skipCount: { increment: 1 }, note: reason ?? entry.note },
    });
    await recordEvent(tx, queueId, 'SKIPPED', { entryId, actorId, meta: { from: entry.status, reason } });
    fx.notify({
      userId: entry.patient.userId,
      type: 'SKIPPED',
      title: `You missed your turn — ${entry.tokenLabel}`,
      body: `You were not present when ${providerLabel(queue)} called you. The doctor may call you again after the current queue — please stay nearby or speak to reception.`,
      data: { queueId, entryId },
    });
    await notifyApproaching(tx, queue, fx);
    return { skipped: entry.tokenLabel };
  });
}

/**
 * Call a missed patient. They are not slotted back into the line: the doctor decides when to
 * recall them, normally once the active queue is done, so waiting patients keep their places.
 */
export async function recallEntry(queueId: string, entryId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue, fx) => {
    requireActiveSession(queue);
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.status !== 'SKIPPED') throw conflict('Only patients who missed their turn can be recalled', 'INVALID_STATE');
    if (entry.sessionDate !== queue.sessionDate) throw conflict('This entry belongs to an earlier session', 'STALE_ENTRY');
    const { waiting } = await orderedWaiting(tx, queue);
    const completed = await completeServing(tx, queue, actorId);
    const now = new Date();
    await tx.queueEntry.update({ where: { id: entry.id }, data: { status: 'SERVING', calledAt: now, recalledAt: now } });
    await recordEvent(tx, queueId, 'RECALLED', { entryId, actorId, meta: { stillWaiting: waiting.length } });
    fx.notify({
      userId: entry.patient.userId,
      type: 'RECALLED',
      title: `You're being called again — ${entry.tokenLabel}`,
      body: `Please proceed to ${providerLabel(queue)} at ${queue.organization.name} now.`,
      data: { queueId, entryId },
    });
    return { completed: completed?.tokenLabel ?? null, recalled: entry.tokenLabel, stillWaiting: waiting.length };
  });
}

export async function markNoShow(queueId: string, entryId: string, actorId: ActorId) {
  return withQueue(queueId, async (tx) => {
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.status !== 'SKIPPED') throw conflict('Only skipped patients can be marked as no-show', 'INVALID_STATE');
    await tx.queueEntry.update({ where: { id: entry.id }, data: { status: 'NO_SHOW' } });
    await recordEvent(tx, queueId, 'NO_SHOW', { entryId, actorId });
    return { noShow: entry.tokenLabel };
  });
}

export async function cancelEntry(queueId: string, entryId: string, actorId: ActorId, reason: string) {
  return withQueue(queueId, async (tx, queue, fx) => {
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.status !== 'WAITING' && entry.status !== 'SKIPPED' && entry.status !== 'BOOKED') {
      throw conflict('Only booked, waiting or missed patients can be cancelled', 'INVALID_STATE');
    }
    await tx.queueEntry.update({ where: { id: entry.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), note: reason } });
    await recordEvent(tx, queueId, 'CANCELLED', { entryId, actorId, meta: { by: 'staff', reason } });
    fx.notify({
      userId: entry.patient.userId,
      type: 'CANCELLED',
      title: `Token ${entry.tokenLabel} was cancelled`,
      body: `${providerLabel(queue)}'s team cancelled your queue entry. Reason: ${reason}`,
      data: { queueId, entryId },
    });
    await notifyApproaching(tx, queue, fx);
    return { cancelled: entry.tokenLabel };
  });
}

/**
 * Controlled priority: only staff can change it, a reason is mandatory, and every
 * change is written to both the queue event log and the audit log.
 */
export async function setPriority(queueId: string, entryId: string, priority: Priority, reason: string, actorId: ActorId) {
  return withQueue(queueId, async (tx, queue, fx) => {
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.status !== 'WAITING') throw conflict('Priority can only be changed while the patient is waiting', 'INVALID_STATE');
    if (entry.priority === priority) return { tokenLabel: entry.tokenLabel, priority };
    await tx.queueEntry.update({ where: { id: entry.id }, data: { priority } });
    await recordEvent(tx, queueId, 'PRIORITY_CHANGED', { entryId, actorId, meta: { from: entry.priority, to: priority, reason } });
    await audit(
      { actorId, action: 'queue.priority_changed', entityType: 'queue_entry', entityId: entryId, meta: { from: entry.priority, to: priority, reason } },
      tx,
    );
    if (priority !== 'NORMAL') {
      fx.notify({
        userId: entry.patient.userId,
        type: 'PRIORITY_CHANGED',
        title: 'You have been given priority',
        body: `Your token ${entry.tokenLabel} for ${providerLabel(queue)} has been moved forward.`,
        data: { queueId, entryId },
      });
    }
    await notifyApproaching(tx, queue, fx);
    return { tokenLabel: entry.tokenLabel, priority };
  });
}

// ─────────────────────────── Closing controls ───────────────────────────

/**
 * Manually stop or reopen new patients for today, without closing the queue: patients already in
 * line are still served. Reopening also lifts today's "stop accepting at" time (not the daily limit).
 */
export async function setJoinsOpen(queueId: string, actorId: ActorId, open: boolean) {
  return withQueue(queueId, async (tx, queue) => {
    requireActiveSession(queue, true);
    await tx.queue.update({
      where: { id: queue.id },
      data: open ? { joinsStopped: false, joinsReopened: true } : { joinsStopped: true },
    });
    await recordEvent(tx, queue.id, open ? 'JOINS_REOPENED' : 'JOINS_STOPPED', { actorId });
    return { acceptingNewPatients: open };
  });
}

// ─────────────────────────── On-the-spot (reception) ───────────────────────────

/**
 * Add a patient who is physically present (e.g. no smartphone) to today's queue. Reception follows
 * the doctor's instructions, so the time cutoff and "stop new patients" don't apply, but the daily
 * limit does unless explicitly overridden (audited). The patient gets a sign-in-less record.
 */
export async function addWalkIn(queueId: string, actorId: ActorId, input: { fullName: string; phone?: string; overrideLimit?: boolean }) {
  return withQueue(queueId, async (tx, queue) => {
    requireActiveSession(queue, true);
    const issued = await issuedFor(tx, queue.id, queue.sessionDate!);
    if (issued >= queue.capacity && !input.overrideLimit) {
      throw conflict(`Today's limit of ${queue.capacity} patients has been reached. Confirm to add over the limit.`, 'QUEUE_FULL');
    }
    const user = await tx.user.create({
      data: {
        email: `walkin-${crypto.randomUUID()}@walkin.qfree.local`,
        fullName: input.fullName,
        phone: input.phone,
        role: 'PATIENT',
        isActive: false, // cannot sign in
        passwordHash: bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 4),
        patient: { create: {} },
      },
      include: { patient: true },
    });
    const { entry, ahead } = await issueToken(tx, queue, user.patient!.id, 'RECEPTION', 'Added at reception');
    await recordEvent(tx, queue.id, 'WALK_IN_ADDED', { entryId: entry.id, actorId, meta: { overLimit: issued >= queue.capacity } });
    if (issued >= queue.capacity) {
      await audit({ actorId, action: 'queue.walk_in_over_limit', entityType: 'queue', entityId: queue.id, meta: { token: entry.tokenLabel } }, tx);
    }
    return { entryId: entry.id, tokenLabel: entry.tokenLabel, patientsAhead: ahead };
  });
}

// ─────────────────────────── Advance booking ───────────────────────────

type BookingQueue = Pick<LoadedQueue, 'avgServiceSeconds'> & {
  organization: Pick<LoadedQueue['organization'], 'hours'>;
  doctor: { schedules: { dayOfWeek: number; startTime: string; endTime: string }[] } | null;
};

/** Consultation slots for a date and the estimated time of the Nth patient that day. */
export function bookingEstimate(queue: BookingQueue, date: string, position: number) {
  const slots = dayAvailability(weekdayOf(date), queue.organization.hours, queue.doctor?.schedules ?? null);
  return { slots, estimatedTime: estimatedTimeForPosition(slots, position, queue.avgServiceSeconds) };
}

export type DayUnavailable = 'NOT_CONSULTING' | 'FULL' | 'NO_TIME_LEFT';

/** Bookable days with remaining places and the estimated time for the next booking. */
export async function getBookingSlots(queueId: string, userId?: string) {
  const queue = await loadQueue(prisma, queueId);
  const today = todayFor(queue);
  const dates = bookableDates(today, queue.advanceBookingDays);
  const counts = dates.length
    ? await prisma.queueEntry.groupBy({
        by: ['sessionDate', 'source'],
        where: { queueId, sessionDate: { in: dates }, status: { not: 'CANCELLED' } },
        _count: true,
      })
    : [];
  const patient = userId ? await prisma.patient.findUnique({ where: { userId }, select: { id: true } }) : null;
  const mine = patient
    ? await prisma.queueEntry.findMany({ where: { queueId, patientId: patient.id, status: 'BOOKED', sessionDate: { in: dates } } })
    : [];

  const days = dates.map((date) => {
    const issued = counts.filter((c) => c.sessionDate === date).reduce((n, c) => n + c._count, 0);
    const advance = counts.find((c) => c.sessionDate === date && c.source === 'ADVANCE')?._count ?? 0;
    const { slots, estimatedTime } = bookingEstimate(queue, date, issued + 1);
    const byCapacity = queue.capacity - issued;
    const byQuota = queue.advanceBookingQuota === null ? Infinity : queue.advanceBookingQuota - advance;
    const remaining = estimatedTime === null ? 0 : Math.max(0, Math.min(byCapacity, byQuota));
    const unavailable: DayUnavailable | null = !slots.length
      ? 'NOT_CONSULTING'
      : Math.min(byCapacity, byQuota) <= 0
        ? 'FULL'
        : estimatedTime === null
          ? 'NO_TIME_LEFT'
          : null;
    const my = mine.find((m) => m.sessionDate === date);
    return {
      date,
      dayOfWeek: weekdayOf(date),
      slots,
      booked: issued,
      remaining,
      nextEstimatedTime: unavailable ? null : estimatedTime,
      available: !unavailable && queue.organization.isActive,
      unavailable,
      myBooking: my ? { entryId: my.id, tokenLabel: my.tokenLabel } : null,
    };
  });
  return {
    queueId,
    advanceBookingDays: queue.advanceBookingDays,
    advanceBookingQuota: queue.advanceBookingQuota,
    capacity: queue.capacity,
    timezone: queue.organization.timezone,
    days,
  };
}

/** Reserve a numbered place in a future day's queue. Tokens for that day are numbered in booking order. */
export async function bookAppointment(queueId: string, userId: string, date: string) {
  const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
  if (!patient) throw forbidden('Only patient accounts can book appointments');
  const settings = await getSettings();
  const upcoming = await prisma.queueEntry.count({ where: { patientId: patient.id, status: 'BOOKED' } });
  if (upcoming >= settings.maxUpcomingBookingsPerPatient) {
    throw conflict(`You can hold at most ${settings.maxUpcomingBookingsPerPatient} upcoming bookings`, 'TOO_MANY_BOOKINGS');
  }

  try {
    return await withQueue(queueId, async (tx, queue, fx) => {
      if (!queue.organization.isActive) throw conflict('This provider is not accepting bookings right now', 'ORG_INACTIVE');
      if (queue.advanceBookingDays <= 0) throw conflict('Advance booking is not available for this queue', 'BOOKING_DISABLED');
      const window = bookableDates(todayFor(queue), queue.advanceBookingDays);
      if (!window.includes(date)) {
        throw conflict(`Appointments can be booked from ${window[0]} to ${window[window.length - 1]}`, 'OUTSIDE_BOOKING_WINDOW');
      }
      const already = await tx.queueEntry.findFirst({ where: { queueId, patientId: patient.id, sessionDate: date, status: 'BOOKED' } });
      if (already) throw conflict(`You already have token ${already.tokenLabel} for this day`, 'ALREADY_BOOKED');

      const issued = await issuedFor(tx, queueId, date);
      const { slots, estimatedTime } = bookingEstimate(queue, date, issued + 1);
      if (!slots.length) throw conflict('The doctor is not consulting on this day', 'NOT_CONSULTING');
      if (issued >= queue.capacity || estimatedTime === null) throw conflict('This day is fully booked', 'DAY_FULL');
      if (queue.advanceBookingQuota !== null) {
        const advance = await tx.queueEntry.count({ where: { queueId, sessionDate: date, source: 'ADVANCE', status: { not: 'CANCELLED' } } });
        if (advance >= queue.advanceBookingQuota) {
          throw conflict('All advance places for this day are taken. On-the-spot places may still be available on the day.', 'DAY_FULL');
        }
      }

      const { _max } = await tx.queueEntry.aggregate({ where: { queueId, sessionDate: date }, _max: { tokenNumber: true } });
      const tokenNumber = (_max.tokenNumber ?? 0) + 1;
      const entry = await tx.queueEntry.create({
        data: {
          queueId,
          patientId: patient.id,
          sessionDate: date,
          tokenNumber,
          tokenLabel: formatToken(queue.tokenPrefix, tokenNumber),
          sortKey: sortKeyForToken(tokenNumber),
          status: 'BOOKED',
          source: 'ADVANCE',
        },
      });
      await recordEvent(tx, queueId, 'BOOKED', { entryId: entry.id, actorId: userId, meta: { date, estimatedTime } });
      fx.notify({
        userId,
        type: 'BOOKED',
        title: `Appointment booked — ${entry.tokenLabel}`,
        body: `${providerLabel(queue)} on ${date}, estimated around ${estimatedTime}. Arrive a little early; you'll be notified when the queue opens.`,
        data: { queueId, entryId: entry.id },
      });
      return { entryId: entry.id, tokenLabel: entry.tokenLabel, date, position: issued + 1, estimatedTime };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw conflict('You already have a booking for this day', 'ALREADY_BOOKED');
    throw err;
  }
}

export async function cancelBooking(queueId: string, userId: string, entryId: string) {
  return withQueue(queueId, async (tx, queue, fx) => {
    const entry = await entryInQueue(tx, queueId, entryId);
    if (entry.patient.userId !== userId) throw notFound('Booking');
    if (entry.status !== 'BOOKED') throw conflict('Only upcoming bookings can be cancelled here', 'INVALID_STATE');
    await tx.queueEntry.update({ where: { id: entry.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), note: 'Booking cancelled by patient' } });
    await recordEvent(tx, queueId, 'CANCELLED', { entryId, actorId: userId, meta: { by: 'patient', booking: true } });
    fx.notify({
      userId,
      type: 'BOOKING_CANCELLED',
      title: `Booking cancelled — ${entry.tokenLabel}`,
      body: `Your appointment with ${providerLabel(queue)} on ${entry.sessionDate} has been cancelled.`,
      data: { queueId, entryId },
    });
    return { cancelled: entry.tokenLabel };
  });
}

/** Cancel bookings for days whose session never opened (run with housekeeping). */
export async function expireStaleBookings() {
  const utcTomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const candidates = await prisma.queueEntry.findMany({
    where: { status: 'BOOKED', sessionDate: { lt: utcTomorrow } },
    select: { id: true, queueId: true, sessionDate: true, queue: { select: { organization: { select: { timezone: true } } } } },
  });
  const stale = candidates.filter((c) => c.sessionDate < todayFor(c.queue));
  const byQueue = new Map<string, string[]>();
  for (const s of stale) byQueue.set(s.queueId, [...(byQueue.get(s.queueId) ?? []), s.id]);
  for (const [queueId, ids] of byQueue) {
    await withQueue(queueId, async (tx, queue, fx) => {
      const entries = await tx.queueEntry.findMany({ where: { id: { in: ids }, status: 'BOOKED' }, include: { patient: { select: { userId: true } } } });
      for (const e of entries) {
        await tx.queueEntry.update({ where: { id: e.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), note: 'Session did not take place' } });
        await recordEvent(tx, queueId, 'CANCELLED', { entryId: e.id, meta: { reason: 'session did not take place' } });
        fx.notify({
          userId: e.patient.userId,
          type: 'BOOKING_CANCELLED',
          title: `Booking ${e.tokenLabel} expired`,
          body: `${providerLabel(queue)}'s queue did not open on ${e.sessionDate}. Please book another day.`,
          data: { queueId, entryId: e.id },
        });
      }
    });
  }
  return stale.length;
}

/** Close queues whose session day has passed (run periodically and on startup). */
export async function closeStaleQueues() {
  const open = await prisma.queue.findMany({
    where: { status: { not: 'CLOSED' }, isArchived: false },
    select: { id: true, sessionDate: true, organization: { select: { timezone: true } } },
  });
  let closed = 0;
  for (const q of open) {
    if (!isSessionCurrent(q)) {
      await closeQueue(q.id, SYSTEM_ACTOR, 'Session ended (automatic)');
      closed++;
    }
  }
  return closed;
}
