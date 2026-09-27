/**
 * Queue state machine. Every mutation runs in a transaction that first takes a row
 * lock on the queue (SELECT … FOR UPDATE), so token numbers, ordering and the single
 * "serving" slot stay consistent under concurrent requests. Notifications and socket
 * broadcasts are collected during the transaction and only sent after it commits.
 *
 *   WAITING ──call──▶ SERVING ──complete/next──▶ COMPLETED
 *      │                 │
 *      │ leave/cancel    └──skip──▶ SKIPPED ──requeue──▶ WAITING
 *      ▼                                │
 *   CANCELLED                           └──no-show / queue closes──▶ NO_SHOW
 */
import type { Priority, QueueEventType } from '../../generated/prisma/client.js';
import { prisma, type Tx } from '../../lib/prisma.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isWithinHours } from '../../lib/time.js';
import { getSettings } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { publishQueue } from '../../realtime/publish.js';
import { sendNotifications, type NotificationInput } from '../notifications/notification.service.js';
import {
  estimateWaitSeconds,
  formatToken,
  nextAverage,
  orderWaiting,
  renumberBand,
  requeueSortKey,
  sortKeyForToken,
  toMinutes,
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
      // New day: close out anything left over and restart token numbering.
      await finalizeSession(tx, queue, fx, actorId, 'Session ended');
      await tx.queue.update({ where: { id: queue.id }, data: { sessionDate: todayFor(queue), lastTokenNumber: 0 } });
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
      if (!queue.organization.isActive) throw conflict('This organization is currently inactive', 'ORG_INACTIVE');
      if (queue.doctor && !queue.doctor.isAvailable) throw conflict('The doctor is currently unavailable', 'DOCTOR_UNAVAILABLE');

      const existing = await tx.queueEntry.findFirst({
        where: { queueId, patientId: patient.id, status: { in: ['WAITING', 'SERVING'] } },
      });
      if (existing) throw conflict(`You are already in this queue with token ${existing.tokenLabel}`, 'ALREADY_IN_QUEUE');

      const issued = await tx.queueEntry.count({
        where: { queueId, sessionDate: queue.sessionDate!, status: { not: 'CANCELLED' } },
      });
      if (issued >= queue.capacity) throw conflict('This queue has reached its capacity for today', 'QUEUE_FULL');

      const { lastTokenNumber: tokenNumber } = await tx.queue.update({
        where: { id: queueId },
        data: { lastTokenNumber: { increment: 1 } },
        select: { lastTokenNumber: true },
      });
      const tokenLabel = formatToken(queue.tokenPrefix, tokenNumber);
      const { waiting, serving } = await orderedWaiting(tx, queue);
      const ahead = waiting.length; // a new NORMAL entry always goes to the back
      const entry = await tx.queueEntry.create({
        data: {
          queueId,
          patientId: patient.id,
          sessionDate: queue.sessionDate!,
          tokenNumber,
          tokenLabel,
          sortKey: sortKeyForToken(tokenNumber),
          approachingNotified: ahead <= queue.approachingThreshold,
        },
      });
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
      title: `Token ${entry.tokenLabel} was skipped`,
      body: `You were not present when called by ${providerLabel(queue)}. Please speak to the reception desk to be re-added.`,
      data: { queueId, entryId },
    });
    await notifyApproaching(tx, queue, fx);
    return { skipped: entry.tokenLabel };
  });
}

/** Put a skipped patient back in line, a couple of places behind the front (grace positions). */
export async function requeueEntry(queueId: string, entryId: string, actorId: ActorId) {
  const { requeueGrace } = await getSettings();
  try {
    return await withQueue(queueId, async (tx, queue, fx) => {
      requireActiveSession(queue, true);
      const entry = await entryInQueue(tx, queueId, entryId);
      if (entry.status !== 'SKIPPED') throw conflict('Only skipped patients can be re-queued', 'INVALID_STATE');
      if (entry.sessionDate !== queue.sessionDate) throw conflict('This entry belongs to an earlier session', 'STALE_ENTRY');

      const { waiting } = await orderedWaiting(tx, queue);
      let band = waiting.filter((w) => w.priority === entry.priority);
      let sortKey = requeueSortKey(band, requeueGrace);
      if (sortKey === null) {
        for (const r of renumberBand(band)) await tx.queueEntry.update({ where: { id: r.id }, data: { sortKey: r.sortKey } });
        band = band.map((b, i) => ({ ...b, sortKey: (i + 1) * 1000 }));
        sortKey = requeueSortKey(band, requeueGrace)!;
      }
      await tx.queueEntry.update({
        where: { id: entry.id },
        data: { status: 'WAITING', sortKey, approachingNotified: false },
      });
      await recordEvent(tx, queueId, 'REQUEUED', { entryId, actorId, meta: { sortKey } });
      fx.notify({
        userId: entry.patient.userId,
        type: 'REQUEUED',
        title: `Token ${entry.tokenLabel} is back in the queue`,
        body: `You have been re-added to ${providerLabel(queue)}'s queue. Please stay nearby.`,
        data: { queueId, entryId },
      });
      await notifyApproaching(tx, queue, fx);
      return { requeued: entry.tokenLabel };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw conflict('This patient already has another active entry in this queue', 'ALREADY_IN_QUEUE');
    }
    throw err;
  }
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
    if (entry.status !== 'WAITING' && entry.status !== 'SKIPPED') {
      throw conflict('Only waiting or skipped patients can be cancelled', 'INVALID_STATE');
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
