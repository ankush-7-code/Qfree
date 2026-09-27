import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { hhmm, idParams, paged, pagination, parse } from '../../lib/validate.js';
import { auditFrom } from '../../lib/audit.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { getSnapshot } from '../queues/queue.state.js';
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
  const where = {
    user: { isActive: true },
    organizationId: q.organizationId,
    organization: { isActive: true, ...(q.city ? { city: { equals: q.city, mode: 'insensitive' as const } } : {}) },
    ...(q.specialization ? { specialization: { contains: q.specialization, mode: 'insensitive' as const } } : {}),
    ...(q.q
      ? {
          OR: [
            { user: { fullName: { contains: q.q, mode: 'insensitive' as const } } },
            { specialization: { contains: q.q, mode: 'insensitive' as const } },
            { organization: { name: { contains: q.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.doctor.findMany({ where, select: doctorPublic, orderBy: { user: { fullName: 'asc' } }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.doctor.count({ where }),
  ]);
  res.json(paged(items.map(flatten), total, q.page, q.pageSize));
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
          .object({ dayOfWeek: z.number().int().min(0).max(6), startTime: hhmm, endTime: hhmm })
          .refine((s) => s.startTime < s.endTime, 'startTime must be before endTime'),
      )
      .max(21),
    req.body,
  );
  const d = await myDoctor(user.id);
  await prisma.$transaction([
    prisma.doctorSchedule.deleteMany({ where: { doctorId: d.id } }),
    prisma.doctorSchedule.createMany({ data: rows.map((r) => ({ ...r, doctorId: d.id })) }),
  ]);
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
  const { queues, ...rest } = d;
  res.json({ ...flatten(rest), queues: await Promise.all(queues.map((q) => getSnapshot(q.id))) });
});
