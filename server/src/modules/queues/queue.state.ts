/**
 * Read models for a queue. One DB round-trip loads the current session; pure builders
 * derive the public snapshot, the staff view and each patient's personal view from it.
 */
import { prisma, type Db } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { localDate, localParts } from '../../lib/time.js';
import {
  entryPhase,
  estimateWaitSeconds,
  JOIN_BLOCK_MESSAGE,
  sameDayJoinBlock,
  orderWaiting,
  progressFraction,
  toMinutes,
  type PriorityLevel,
} from './queue.logic.js';

const queueInclude = {
  organization: {
    select: { id: true, name: true, type: true, city: true, address: true, timezone: true, isActive: true, hours: true },
  },
  doctor: {
    select: {
      id: true,
      specialization: true,
      isAvailable: true,
      user: { select: { id: true, fullName: true } },
      schedules: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  },
  service: { select: { id: true, name: true, category: true } },
} as const;

const entryInclude = {
  patient: {
    select: {
      userId: true,
      dateOfBirth: true,
      gender: true,
      user: { select: { fullName: true, phone: true } },
    },
  },
} as const;

export async function loadQueue(db: Db, queueId: string) {
  const queue = await db.queue.findUnique({ where: { id: queueId }, include: queueInclude });
  if (!queue || queue.isArchived) throw notFound('Queue');
  return queue;
}
export type LoadedQueue = Awaited<ReturnType<typeof loadQueue>>;

export async function loadQueueState(db: Db, queueId: string) {
  const queue = await loadQueue(db, queueId);
  const current = isSessionCurrent(queue);
  const entries = current
    ? await db.queueEntry.findMany({
        where: { queueId, sessionDate: queue.sessionDate! },
        include: entryInclude,
        orderBy: { tokenNumber: 'asc' },
      })
    : [];
  return { queue, entries, now: new Date() };
}
export type QueueState = Awaited<ReturnType<typeof loadQueueState>>;
type StateEntry = QueueState['entries'][number];

export const todayFor = (queue: { organization: { timezone: string } }) => localDate(queue.organization.timezone);

export const isSessionCurrent = (queue: { sessionDate: string | null; organization: { timezone: string } }) =>
  queue.sessionDate !== null && queue.sessionDate === todayFor(queue);

/** A queue left open past midnight is treated as closed until it is reopened. */
export function effectiveStatus(queue: LoadedQueue) {
  if (queue.status !== 'CLOSED' && !isSessionCurrent(queue)) return 'CLOSED' as const;
  return queue.status;
}

export function splitState(state: QueueState) {
  const serving = state.entries.find((e) => e.status === 'SERVING') ?? null;
  const waiting = orderWaiting(
    state.entries.filter((e) => e.status === 'WAITING').map((e) => ({ ...e, priority: e.priority as PriorityLevel })),
  );
  return { serving, waiting };
}

function providerInfo(queue: LoadedQueue) {
  return {
    organization: {
      id: queue.organization.id,
      name: queue.organization.name,
      type: queue.organization.type,
      city: queue.organization.city,
      address: queue.organization.address,
    },
    doctor: queue.doctor
      ? { id: queue.doctor.id, name: queue.doctor.user.fullName, specialization: queue.doctor.specialization, isAvailable: queue.doctor.isAvailable }
      : null,
    service: queue.service,
  };
}

/** Public, anonymous-safe snapshot: contains no patient identities. */
export function buildSnapshot(state: QueueState) {
  const { queue, entries, now } = state;
  const { serving, waiting } = splitState(state);
  const status = effectiveStatus(queue);
  const issued = entries.filter((e) => e.status !== 'CANCELLED').length;
  const lastCalled = entries
    .filter((e) => e.calledAt)
    .sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime())[0];
  const joinBlock = sameDayJoinBlock({
    status,
    orgActive: queue.organization.isActive,
    doctorAvailable: queue.doctor ? queue.doctor.isAvailable : true,
    joinsStopped: queue.joinsStopped,
    joinsReopened: queue.joinsReopened,
    capacity: queue.capacity,
    issued,
    cutoffTime: queue.joinCutoffTime,
    localTime: localParts(queue.organization.timezone, now).time,
    allowSameDayJoin: queue.allowSameDayJoin,
  });

  return {
    id: queue.id,
    name: queue.name,
    tokenPrefix: queue.tokenPrefix,
    status,
    ...providerInfo(queue),
    sessionDate: queue.sessionDate,
    currentToken: serving?.tokenLabel ?? null,
    servingSince: serving?.calledAt ?? null,
    lastCalledToken: lastCalled?.tokenLabel ?? null,
    lastIssuedToken: entries.length ? entries[entries.length - 1].tokenLabel : null,
    waitingCount: waiting.length,
    servedCount: entries.filter((e) => e.status === 'COMPLETED').length,
    capacity: queue.capacity,
    remainingCapacity: Math.max(0, queue.capacity - issued),
    avgServiceMinutes: Math.round((queue.avgServiceSeconds / 60) * 10) / 10,
    estimatedWaitMinutes: toMinutes(estimateWaitSeconds(waiting.length, queue.avgServiceSeconds, serving?.calledAt ?? null, now)),
    approachingThreshold: queue.approachingThreshold,
    isAcceptingPatients: joinBlock === null,
    joinBlock,
    joinBlockMessage: joinBlock ? JOIN_BLOCK_MESSAGE[joinBlock] : null,
    missedCount: entries.filter((e) => e.status === 'SKIPPED').length,
    closingRules: {
      capacity: queue.capacity,
      cutoffTime: queue.joinCutoffTime,
      joinsStopped: queue.joinsStopped,
      joinsReopened: queue.joinsReopened,
    },
    allowSameDayJoin: queue.allowSameDayJoin,
    advanceBookingDays: queue.advanceBookingDays,
    advanceBookingQuota: queue.advanceBookingQuota,
    pausedAt: queue.status === 'PAUSED' ? queue.pausedAt : null,
    updatedAt: now,
  };
}
export type QueueSnapshot = ReturnType<typeof buildSnapshot>;

/** Personal view for the patient who owns `entry`. */
export function buildEntryView(state: QueueState, entry: StateEntry) {
  const { queue, now } = state;
  const { serving, waiting } = splitState(state);
  const idx = waiting.findIndex((w) => w.id === entry.id);
  const patientsAhead = idx >= 0 ? idx : 0;
  const status = effectiveStatus(queue);
  const waitSeconds =
    entry.status === 'WAITING' ? estimateWaitSeconds(patientsAhead, queue.avgServiceSeconds, serving?.calledAt ?? null, now) : 0;
  const tokensBefore = state.entries.filter(
    (e) => e.tokenNumber < entry.tokenNumber && e.status !== 'CANCELLED',
  ).length;

  return {
    queueId: queue.id,
    entry: {
      id: entry.id,
      tokenLabel: entry.tokenLabel,
      tokenNumber: entry.tokenNumber,
      status: entry.status,
      priority: entry.priority,
      joinedAt: entry.joinedAt,
      calledAt: entry.calledAt,
      recalledAt: entry.recalledAt,
      completedAt: entry.completedAt,
      cancelledAt: entry.cancelledAt,
      source: entry.source,
    },
    currentToken: serving?.tokenLabel ?? null,
    patientsAhead,
    estimatedWaitMinutes: toMinutes(waitSeconds),
    expectedAt: entry.status === 'WAITING' ? new Date(now.getTime() + waitSeconds * 1000) : null,
    phase: entryPhase(entry.status, patientsAhead, queue.approachingThreshold, status),
    progress: entry.status === 'WAITING' ? progressFraction(tokensBefore, patientsAhead) : 1,
    queueStatus: status,
  };
}
export type EntryView = ReturnType<typeof buildEntryView>;

function ageFrom(dob: Date | null, now: Date) {
  if (!dob) return null;
  const years = now.getFullYear() - dob.getFullYear();
  const hadBirthday =
    now.getMonth() > dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
  return hadBirthday ? years : years - 1;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Full operational view for doctors and staff of the queue's organization. */
export function buildStaffView(state: QueueState) {
  const { entries, now, queue } = state;
  const { serving, waiting } = splitState(state);
  const staffEntry = (e: StateEntry) => ({
    id: e.id,
    tokenLabel: e.tokenLabel,
    tokenNumber: e.tokenNumber,
    status: e.status,
    priority: e.priority,
    skipCount: e.skipCount,
    joinedAt: e.joinedAt,
    calledAt: e.calledAt,
    recalledAt: e.recalledAt,
    completedAt: e.completedAt,
    cancelledAt: e.cancelledAt,
    source: e.source,
    note: e.note,
    patient: {
      name: e.patient.user.fullName,
      phone: e.patient.user.phone,
      age: ageFrom(e.patient.dateOfBirth, now),
      gender: e.patient.gender,
    },
  });

  const waited = entries.filter((e) => e.calledAt).map((e) => (e.calledAt!.getTime() - e.joinedAt.getTime()) / 60000);
  const consult = entries
    .filter((e) => e.status === 'COMPLETED' && e.calledAt && e.completedAt)
    .map((e) => (e.completedAt!.getTime() - e.calledAt!.getTime()) / 60000);
  const count = (s: string) => entries.filter((e) => e.status === s).length;
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

  return {
    snapshot: buildSnapshot(state),
    serving: serving ? staffEntry(serving) : null,
    waiting: waiting.map((e, i) => ({
      ...staffEntry(e),
      position: i + 1,
      estimatedWaitMinutes: toMinutes(estimateWaitSeconds(i, queue.avgServiceSeconds, serving?.calledAt ?? null, now)),
    })),
    // Missed patients wait outside the line; the doctor recalls them when they decide.
    missed: entries.filter((e) => e.status === 'SKIPPED').map(staffEntry),
    finished: entries
      .filter((e) => ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(e.status))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 50)
      .map(staffEntry),
    stats: {
      total: entries.length,
      waiting: waiting.length,
      served: count('COMPLETED'),
      missed: count('SKIPPED'),
      recalled: entries.filter((e) => e.recalledAt).length,
      cancelled: count('CANCELLED'),
      noShow: count('NO_SHOW'),
      avgWaitMinutes: round(avg(waited)),
      avgConsultMinutes: round(avg(consult)),
    },
  };
}
export type StaffView = ReturnType<typeof buildStaffView>;

// ── Convenience readers used by routes ──

export async function getSnapshot(queueId: string) {
  return buildSnapshot(await loadQueueState(prisma, queueId));
}

export async function getStaffView(queueId: string) {
  return buildStaffView(await loadQueueState(prisma, queueId));
}

/** The patient's active entry in this session, or their most recent one today (so they see "done"). */
export async function getMyEntry(queueId: string, userId: string) {
  const state = await loadQueueState(prisma, queueId);
  const mine = state.entries.filter((e) => e.patient.userId === userId);
  const entry =
    mine.find((e) => e.status === 'WAITING' || e.status === 'SERVING') ??
    mine.sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())[0];
  return entry ? buildEntryView(state, entry) : null;
}
