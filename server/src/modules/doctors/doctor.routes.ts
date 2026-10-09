import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { hhmm, idParams, paged, pagination, parse } from '../../lib/validate.js';
import { auditFrom } from '../../lib/audit.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { getSnapshot } from '../queues/queue.state.js';
import { addDays, dayAvailability, weekdayOf } from '../queues/queue.logic.js';
import { localParts } from '../../lib/time.js';
import { publishQueue } from '../../realtime/publish.js';

export const doctorRouter = Router();

const doctorPublic = {
  id: true,
  specialization: true,
  qualification: true,
  experienceYears: true,
  bio: true,
  consultationMinutes: true,
  isAvailable: true,
  user: { select: { fullName: true } },
  organization: { select: { id: true, name: true, type: true, city: true, address: true } },
} as const;

type DoctorRow = { user: { fullName: string } } & Record<string, unknown>;
const flatten = <T extends DoctorRow>({ user, ...d }: T) => ({ ...d, name: user.fullName });

doctorRouter.get('/', async (req, res) => {
  const q = parse(
    pagination.extend({
      q: z.string().trim().max(100).optional(),
      specialization: z.string().trim().max(100).optional(),
      city: z.string().trim().max(80).optional(),
      organizationId: z.string().uuid().optional(),
    }),
    req.query,
  );
  // Doctors who haven't joined a clinic yet are still listed (they have no city, so a city
  // filter excludes them); doctors of suspended organizations are hidden.
  const orgFilter = q.city
    ? { organization: { isActive: true, city: { equals: q.city, mode: 'insensitive' as const } } }
    : { OR: [{ organizationId: null }, { organization: { isActive: true } }] };
  const textFilter = q.q
    ? {
        OR: [
          { user: { fullName: { contains: q.q, mode: 'insensitive' as const } } },
          { specialization: { contains: q.q, mode: 'insensitive' as const } },
          { organization: { name: { contains: q.q, mode: 'insensitive' as const } } },
        ],
      }
    : {};
  const where = {
    user: { isActive: true },
    organizationId: q.organizationId,
    ...(q.specialization ? { specialization: { contains: q.specialization, mode: 'insensitive' as const } } : {}),
    AND: [orgFilter, textFilter],
  };
  const [items, total] = await Promise.all([
    prisma.doctor.findMany({ where, select: doctorPublic, orderBy: { user: { fullName: 'asc' } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.doctor.count({ where }),
  ]);
  res.json(paged(items.map(flatten), total, q.page, q.pageSize));
});

/**
 * Doctors for the home page showcase: those whose queue is open right now ("live"), with real queue
 * numbers. When nobody is live, every doctor with a queue is returned with their next consulting time.
 * Cached briefly so a busy home page doesn't recompute every queue on each visit.
 */
let featuredCache: { at: number; body: unknown } | null = null;
doctorRouter.get('/featured', async (_req, res) => {
  if (featuredCache && Date.now() - featuredCache.at < 15_000) {
    res.json(featuredCache.body);
    return;
  }
  const doctors = await prisma.doctor.findMany({
    where: { user: { isActive: true }, organization: { isActive: true }, queues: { some: { isArchived: false } } },
    select: {
      id: true,
      specialization: true,
      user: { select: { fullName: true } },
      schedules: { select: { dayOfWeek: true, startTime: true, endTime: true } },
      organization: {
        select: { id: true, name: true, city: true, timezone: true, hours: { select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true } } },
      },
      queues: { where: { isArchived: false }, select: { id: true }, orderBy: { createdAt: 'asc' } },
    },
    take: 60,
  });
  const all = await Promise.all(
    doctors.map(async (d) => {
      const snapshots = await Promise.all(d.queues.map((q) => getSnapshot(q.id)));
      const liveQueue = snapshots.find((s) => s.status !== 'CLOSED') ?? null;
      const q = liveQueue ?? snapshots[0];
      const org = d.organization!;
      return {
        id: d.id,
        name: d.user.fullName,
        specialization: d.specialization,
        organization: { id: org.id, name: org.name, city: org.city },
        live: !!liveQueue,
        queue: {
          id: q.id,
          status: q.status,
          currentToken: q.currentToken,
          waitingCount: q.waitingCount,
          estimatedWaitMinutes: q.estimatedWaitMinutes,
          isAcceptingPatients: q.isAcceptingPatients,
        },
        nextAvailable: doctorAvailability(d.schedules, org.hours, org.timezone).next,
      };
    }),
  );
  const live = all.filter((d) => d.live);
  const body = { anyLive: live.length > 0, items: live.length ? live : all };
  featuredCache = { at: Date.now(), body };
  res.json(body);
});

doctorRouter.get('/specializations', async (_req, res) => {
  const rows = await prisma.doctor.findMany({ distinct: ['specialization'], select: { specialization: true }, orderBy: { specialization: 'asc' } });
  res.json(rows.map((r) => r.specialization));
});

// ─── Own profile (doctor) — registered before /:id so "me" is not treated as an id ───

const me = Router();
me.use(authenticate, requireRole('DOCTOR'));

async function myDoctor(userId: string) {
  const d = await prisma.doctor.findUnique({
    where: { userId },
    include: {
      user: { select: { fullName: true, email: true, phone: true } },
      organization: { select: { id: true, name: true, type: true, city: true } },
      schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
      queues: { where: { isArchived: false }, select: { id: true } },
    },
  });
  if (!d) throw notFound('Doctor profile');
  return d;
}

me.get('/', async (req, res) => {
  const { queues, ...d } = await myDoctor(currentUser(req).id);
  res.json({ ...d, queues: await Promise.all(queues.map((q) => getSnapshot(q.id))) });
});

me.patch('/', async (req, res) => {
  const user = currentUser(req);
  const body = parse(
    z.object({
      fullName: z.string().trim().min(2).max(100).optional(),
      phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).optional(),
      specialization: z.string().trim().min(2).max(100).optional(),
      qualification: z.string().trim().max(200).optional(),
      experienceYears: z.coerce.number().int().min(0).max(70).optional(),
      bio: z.string().trim().max(2000).optional(),
      consultationMinutes: z.coerce.number().int().min(1).max(120).optional(),
    }),
    req.body,
  );
  const { fullName, phone, ...doctor } = body;
  await prisma.user.update({ where: { id: user.id }, data: { fullName, phone } });
  await prisma.doctor.update({ where: { userId: user.id }, data: doctor });
  await auditFrom(req, { action: 'doctor.profile_update', entityType: 'doctor', entityId: user.id });
  res.json(await myDoctor(user.id));
});

me.patch('/availability', async (req, res) => {
  const user = currentUser(req);
  const { isAvailable } = parse(z.object({ isAvailable: z.boolean() }), req.body);
  const d = await prisma.doctor.update({ where: { userId: user.id }, data: { isAvailable }, include: { queues: { select: { id: true } } } });
  await Promise.all(d.queues.map((q) => publishQueue(q.id)));
  res.json({ isAvailable: d.isAvailable });
});

me.put('/schedule', async (req, res) => {
  const user = currentUser(req);
  const rows = parse(
    z
      .array(
        z
          .object({
            dayOfWeek: z.number().int().min(0).max(6),
            startTime: hhmm,
            endTime: hhmm,
            // Patient limit for this consulting session, set by the doctor; null/omitted = no limit.
            maxPatients: z.coerce.number().int().min(1).max(1000).nullable().optional(),
          })
          .refine((s) => s.startTime < s.endTime, 'startTime must be before endTime'),
      )
      .max(21)
      .refine(
        (all) =>
          all.every((a, i) => all.every((b, j) => i === j || a.dayOfWeek !== b.dayOfWeek || a.endTime <= b.startTime || b.endTime <= a.startTime)),
        'Sessions on the same day must not overlap',
      ),
    req.body,
  );
  const d = await myDoctor(user.id);
  await prisma.$transaction([
    prisma.doctorSchedule.deleteMany({ where: { doctorId: d.id } }),
    prisma.doctorSchedule.createMany({ data: rows.map((r) => ({ ...r, maxPatients: r.maxPatients ?? null, doctorId: d.id })) }),
  ]);
  await auditFrom(req, { action: 'doctor.schedule_update', entityType: 'doctor', entityId: d.id });
  // Session limits affect whether the doctor's queues accept patients right now.
  await Promise.all(d.queues.map((q) => publishQueue(q.id)));
  res.json(await prisma.doctorSchedule.findMany({ where: { doctorId: d.id }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] }));
});

doctorRouter.use('/me', me);

doctorRouter.get('/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const d = await prisma.doctor.findFirst({
    where: { id, user: { isActive: true } },
    select: {
      ...doctorPublic,
      schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }], select: { dayOfWeek: true, startTime: true, endTime: true } },
      queues: { where: { isArchived: false }, select: { id: true } },
    },
  });
  if (!d) throw notFound('Doctor');
  const clinic = d.organization
    ? await prisma.organization.findUnique({
        where: { id: d.organization.id },
        select: { phone: true, timezone: true, hours: { select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true } } },
      })
    : null;
  const { queues, ...rest } = d;
  res.json({
    ...flatten(rest),
    organization: d.organization && clinic ? { ...d.organization, phone: clinic.phone, timezone: clinic.timezone } : null,
    availability: doctorAvailability(d.schedules, clinic?.hours ?? null, clinic?.timezone ?? 'Asia/Kolkata'),
    queues: await Promise.all(queues.map((q) => getSnapshot(q.id))),
  });
});

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '00:00', closeTime: '23:59', isClosed: false }));

/**
 * When the doctor consults, in the clinic's local time: their published timings within the clinic's
 * opening days (same rules as booking), whether they are consulting right now, and the next day they consult.
 */
function doctorAvailability(
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[],
  orgHours: { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }[] | null,
  timezone: string,
) {
  const hours = orgHours ?? ALL_DAY;
  const { date: today, time: now } = localParts(timezone);
  const todaySlots = dayAvailability(weekdayOf(today), hours, schedules);
  let next: { date: string; slots: { start: string; end: string }[] } | null = null;
  for (let i = 0; i <= 14 && !next; i++) {
    const date = addDays(today, i);
    const slots = dayAvailability(weekdayOf(date), hours, schedules).filter((s) => i > 0 || s.end > now);
    if (slots.length) next = { date, slots };
  }
  return {
    timezone,
    today,
    todaySlots,
    consultingNow: todaySlots.some((s) => s.start <= now && now < s.end),
    next,
    weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ dayOfWeek: day, slots: dayAvailability(day, hours, schedules) })),
  };
}
