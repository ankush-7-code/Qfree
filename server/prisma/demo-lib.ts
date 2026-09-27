/** Shared helpers for demo data: deterministic randomness, queue history and live-session simulation. */
import type { EntryStatus, Prisma, Queue } from '../src/generated/prisma/client.js';
import { prisma } from '../src/lib/prisma.js';
import { localDate } from '../src/lib/time.js';
import { formatToken, sortKeyForToken } from '../src/modules/queues/queue.logic.js';

export const TZ = 'Asia/Kolkata';
export const PASSWORD = 'Password123';
export const MIN = 60_000;

// Deterministic PRNG so every seed produces the same data.
let state = 42;
export const rand = () => ((state = (state * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
export const between = (a: number, b: number) => a + rand() * (b - a);
export const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
export const normal = (mean: number, sd: number) => {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export const week = (open: string, close: string, closedDays: number[] = []) =>
  [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: open, closeTime: close, isClosed: closedDays.includes(d) }));

export interface HistorySpec {
  q: Pick<Queue, 'id' | 'tokenPrefix'>;
  avg: number; // minutes per patient
  perDay: [number, number];
  closedSun: boolean;
}

/** 30 days of past sessions from a single-server queue simulation with morning and evening peaks. */
export async function simulateHistory(specs: HistorySpec[], patientIds: string[], now = new Date(), days = 30) {
  const history: Prisma.QueueEntryCreateManyInput[] = [];
  for (let d = days; d >= 1; d--) {
    const sessionDate = localDate(TZ, new Date(now.getTime() - d * 86_400_000));
    const dow = new Date(`${sessionDate}T12:00:00+05:30`).getUTCDay();
    for (const spec of specs) {
      if (spec.closedSun && dow === 0) continue;
      const count = Math.round(between(spec.perDay[0], spec.perDay[1]) * (dow === 1 ? 1.25 : dow === 6 ? 0.8 : 1));
      const arrivals = Array.from({ length: count }, () => {
        const hour = rand() < 0.62 ? normal(10.2, 1.0) : normal(18.4, 0.9);
        return new Date(Date.parse(`${sessionDate}T00:00:00+05:30`) + Math.min(Math.max(hour, 8), 21.5) * 3_600_000);
      }).sort((a, b) => a.getTime() - b.getTime());

      let free = 0;
      arrivals.forEach((joinedAt, i) => {
        const tokenNumber = i + 1;
        const r = rand();
        const status: EntryStatus = r < 0.07 ? 'CANCELLED' : r < 0.11 ? 'NO_SHOW' : 'COMPLETED';
        const base = {
          queueId: spec.q.id, patientId: pick(patientIds), sessionDate, tokenNumber,
          tokenLabel: formatToken(spec.q.tokenPrefix, tokenNumber), sortKey: sortKeyForToken(tokenNumber), joinedAt, approachingNotified: true,
        };
        if (status === 'CANCELLED') {
          history.push({ ...base, status, cancelledAt: new Date(joinedAt.getTime() + between(5, 40) * MIN), note: 'Left by patient' });
          return;
        }
        const calledAt = new Date(Math.max(joinedAt.getTime() + between(1, 4) * MIN, free));
        if (status === 'NO_SHOW') {
          history.push({ ...base, status, calledAt, skipCount: 1 });
          free = calledAt.getTime() + MIN;
          return;
        }
        const completedAt = new Date(calledAt.getTime() + Math.max(1.5, normal(spec.avg, spec.avg * 0.35)) * MIN);
        free = completedAt.getTime() + between(0.3, 1.5) * MIN;
        history.push({ ...base, status, calledAt, completedAt, priority: rand() < 0.03 ? 'PRIORITY' : 'NORMAL' });
      });
    }
  }
  for (let i = 0; i < history.length; i += 1000) await prisma.queueEntry.createMany({ data: history.slice(i, i + 1000) });
  return history.length;
}

export interface LiveSpec {
  q: Pick<Queue, 'id' | 'tokenPrefix'>;
  served: number;
  waiting: number;
  avg: number;
  status?: 'OPEN' | 'PAUSED';
}

/** Today's session: `served` completed, one being served, `waiting` in line, plus the event trail. */
export async function seedLiveSession(spec: LiveSpec, patientIds: string[], now = new Date(), actorId: string | null = null) {
  const today = localDate(TZ, now);
  const pool = [...patientIds].sort(() => rand() - 0.5);
  const total = spec.served + 1 + spec.waiting;
  const entries: Prisma.QueueEntryCreateManyInput[] = [];
  for (let t = 1; t <= total; t++) {
    const base = {
      queueId: spec.q.id, patientId: pool[(t - 1) % pool.length], sessionDate: today, tokenNumber: t,
      tokenLabel: formatToken(spec.q.tokenPrefix, t), sortKey: sortKeyForToken(t),
    };
    if (t <= spec.served) {
      const calledAt = new Date(now.getTime() - ((spec.served + 1 - t) * spec.avg + 4) * MIN);
      entries.push({ ...base, status: 'COMPLETED', joinedAt: new Date(calledAt.getTime() - between(12, 40) * MIN), calledAt, completedAt: new Date(calledAt.getTime() + spec.avg * between(0.8, 1.15) * MIN), approachingNotified: true });
    } else if (t === spec.served + 1) {
      entries.push({ ...base, status: 'SERVING', joinedAt: new Date(now.getTime() - 38 * MIN), calledAt: new Date(now.getTime() - 3 * MIN), approachingNotified: true });
    } else {
      const k = t - spec.served - 1;
      entries.push({ ...base, status: 'WAITING', joinedAt: new Date(now.getTime() - (spec.waiting - k + 1) * 5 * MIN), approachingNotified: k <= 4 });
    }
  }
  await prisma.queueEntry.createMany({ data: entries });
  const openedAt = new Date(now.getTime() - 4 * 3_600_000);
  await prisma.queue.update({
    where: { id: spec.q.id },
    data: { status: spec.status ?? 'OPEN', sessionDate: today, lastTokenNumber: total, openedAt, pausedAt: spec.status === 'PAUSED' ? new Date(now.getTime() - 10 * MIN) : null },
  });

  const created = await prisma.queueEntry.findMany({ where: { queueId: spec.q.id, sessionDate: today } });
  const events: Prisma.QueueEventCreateManyInput[] = [{ queueId: spec.q.id, type: 'OPENED', actorId, createdAt: openedAt }];
  for (const e of created) {
    events.push({ queueId: e.queueId, entryId: e.id, actorId: null, type: 'JOINED', createdAt: e.joinedAt });
    if (e.calledAt) events.push({ queueId: e.queueId, entryId: e.id, actorId, type: 'CALLED', createdAt: e.calledAt });
    if (e.completedAt) events.push({ queueId: e.queueId, entryId: e.id, actorId, type: 'COMPLETED', createdAt: e.completedAt });
  }
  await prisma.queueEvent.createMany({ data: events });
  return created.length;
}

export const doctorSchedule = () =>
  [1, 2, 3, 4, 5, 6].flatMap((d) => [
    { dayOfWeek: d, startTime: '09:00', endTime: '13:00' },
    { dayOfWeek: d, startTime: '17:00', endTime: '21:00' },
  ]);
