import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { idParams, paged, pagination, parse } from '../../lib/validate.js';
import { auditFrom } from '../../lib/audit.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { getMyEntry } from '../queues/queue.state.js';
import { bookingEstimate } from '../queues/queue.service.js';

export const patientRouter = Router();
patientRouter.use(authenticate);

async function patientFor(userId: string) {
  const p = await prisma.patient.findUnique({ where: { userId } });
  if (!p) throw notFound('Patient profile');
  return p;
}

patientRouter.get('/me', requireRole('PATIENT'), async (req, res) => {
  const user = currentUser(req);
  const p = await prisma.patient.findUnique({
    where: { userId: user.id },
    include: { user: { select: { fullName: true, email: true, phone: true, createdAt: true } } },
  });
  if (!p) throw notFound('Patient profile');
  res.json(p);
});

patientRouter.patch('/me', requireRole('PATIENT'), async (req, res) => {
  const user = currentUser(req);
  const body = parse(
    z.object({
      fullName: z.string().trim().min(2).max(100).optional(),
      phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).optional().nullable(),
      dateOfBirth: z.coerce.date().max(new Date()).optional().nullable(),
      gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional().nullable(),
    }),
    req.body,
  );
  const { fullName, phone, ...patient } = body;
  await prisma.user.update({ where: { id: user.id }, data: { fullName, phone } });
  await prisma.patient.update({ where: { userId: user.id }, data: patient });
  await auditFrom(req, { action: 'patient.profile_update', entityType: 'patient', entityId: user.id });
  res.json(await prisma.patient.findUnique({ where: { userId: user.id }, include: { user: { select: { fullName: true, email: true, phone: true } } } }));
});

/** Active queues for the signed-in patient with live position/ETA. */
patientRouter.get('/me/queues', requireRole('PATIENT'), async (req, res) => {
  const user = currentUser(req);
  const p = await patientFor(user.id);
  const active = await prisma.queueEntry.findMany({
    where: { patientId: p.id, status: { in: ['WAITING', 'SERVING'] } },
    select: { queueId: true },
    distinct: ['queueId'],
  });
  const views = await Promise.all(active.map((a) => getMyEntry(a.queueId, user.id)));
  const queues = await prisma.queue.findMany({
    where: { id: { in: active.map((a) => a.queueId) } },
    select: {
      id: true,
      name: true,
      status: true,
      organization: { select: { id: true, name: true, city: true } },
      doctor: { select: { id: true, specialization: true, user: { select: { fullName: true } } } },
      service: { select: { id: true, name: true } },
    },
  });
  res.json({
    items: views
      .filter((v) => v !== null)
      .map((v) => ({ ...v, queue: queues.find((q) => q.id === v.queueId) })),
  });
});

async function history(patientId: string, page: number, pageSize: number) {
  const where = { patientId };
  const [items, total] = await Promise.all([
    prisma.queueEntry.findMany({
      where,
      orderBy: { joinedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        tokenLabel: true,
        status: true,
        priority: true,
        sessionDate: true,
        joinedAt: true,
        calledAt: true,
        completedAt: true,
        cancelledAt: true,
        queue: {
          select: {
            id: true,
            name: true,
            organization: { select: { id: true, name: true } },
            doctor: { select: { id: true, specialization: true, user: { select: { fullName: true } } } },
            service: { select: { name: true } },
          },
        },
      },
    }),
    prisma.queueEntry.count({ where }),
  ]);
  return paged(
    items.map((e) => ({
      ...e,
      waitedMinutes: e.calledAt ? Math.round((e.calledAt.getTime() - e.joinedAt.getTime()) / 60000) : null,
    })),
    total,
    page,
    pageSize,
  );
}

/** Upcoming advance bookings with the estimated consultation time. */
patientRouter.get('/me/bookings', requireRole('PATIENT'), async (req, res) => {
  const p = await patientFor(currentUser(req).id);
  const bookings = await prisma.queueEntry.findMany({
    where: { patientId: p.id, status: 'BOOKED' },
    orderBy: [{ sessionDate: 'asc' }, { tokenNumber: 'asc' }],
    include: {
      queue: {
        select: {
          id: true,
          name: true,
          avgServiceSeconds: true,
          organization: { select: { id: true, name: true, address: true, city: true, hours: true } },
          doctor: { select: { id: true, specialization: true, user: { select: { fullName: true } }, schedules: true } },
          service: { select: { name: true } },
        },
      },
    },
  });
  const items = await Promise.all(
    bookings.map(async (b) => {
      // Position in that day's line = tokens before this one that are still valid, plus one.
      const before = await prisma.queueEntry.count({
        where: { queueId: b.queueId, sessionDate: b.sessionDate, tokenNumber: { lt: b.tokenNumber }, status: { not: 'CANCELLED' } },
      });
      // Bookings carry their chosen slot; older bookings fall back to a position-based estimate.
      const estimatedTime = b.appointmentTime ?? bookingEstimate(b.queue, b.sessionDate, before + 1).estimatedTime;
      const { organization, doctor } = b.queue;
      return {
        entryId: b.id,
        tokenLabel: b.tokenLabel,
        date: b.sessionDate,
        position: before + 1,
        estimatedTime,
        bookedAt: b.joinedAt,
        queue: {
          id: b.queue.id,
          name: b.queue.name,
          service: b.queue.service,
          organization: { id: organization.id, name: organization.name, address: organization.address, city: organization.city },
          doctor: doctor ? { id: doctor.id, name: doctor.user.fullName, specialization: doctor.specialization } : null,
        },
      };
    }),
  );
  res.json({ items });
});

patientRouter.get('/me/history', requireRole('PATIENT'), async (req, res) => {
  const q = parse(pagination, req.query);
  const p = await patientFor(currentUser(req).id);
  res.json(await history(p.id, q.page, q.pageSize));
});

/** History by patient id: the patient themself or an administrator. */
patientRouter.get('/:id/history', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const q = parse(pagination, req.query);
  const user = currentUser(req);
  const p = await prisma.patient.findUnique({ where: { id } });
  if (!p) throw notFound('Patient');
  if (user.role !== 'ADMIN' && p.userId !== user.id) throw forbidden();
  if (user.role === 'ADMIN') await auditFrom(req, { action: 'patient.history_view', entityType: 'patient', entityId: id });
  res.json(await history(p.id, q.page, q.pageSize));
});
