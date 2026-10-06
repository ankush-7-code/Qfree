import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hhmm, idParams, paged, pagination, parse, uuid } from '../../lib/validate.js';
import { auditFrom } from '../../lib/audit.js';
import { authenticate, currentUser, optionalAuth, requireRole } from '../../middleware/auth.js';
import { joinLimiter } from '../../middleware/rateLimit.js';
import { assertCanManageQueue, isOrgStaff, myDoctorId } from '../access.js';
import { publishQueue } from '../../realtime/publish.js';
import * as svc from './queue.service.js';
import { getMyEntry, getSnapshot, getStaffView } from './queue.state.js';

export const queueRouter = Router();

const entryParams = z.object({ id: uuid, entryId: uuid });
const qid = (req: { params: unknown }) => parse(idParams, req.params).id;

// Field rules without defaults: updates must only touch the fields that were sent
// (Zod applies `.default()` even inside `.partial()`).
const queueFields = {
  doctorId: uuid.nullable(),
  serviceId: uuid.nullable(),
  name: z.string().trim().min(2).max(100),
  tokenPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,4}$/, 'Prefix must be 1–4 letters'),
  // Closing rules: `capacity` is the daily patient limit; `joinCutoffTime` stops new patients at a
  // local time. With both set, whichever is reached first closes new joins.
  capacity: z.coerce.number().int().min(1).max(5000),
  joinCutoffTime: hhmm.nullable(),
  avgServiceMinutes: z.coerce.number().min(1).max(60),
  approachingThreshold: z.coerce.number().int().min(1).max(20),
  allowSameDayJoin: z.boolean(),
  advanceBookingDays: z.coerce.number().int().min(0).max(60),
  advanceBookingQuota: z.coerce.number().int().min(1).max(5000).nullable(),
};

const createQueueBody = z.object({
  ...queueFields,
  organizationId: uuid,
  doctorId: queueFields.doctorId.optional(),
  serviceId: queueFields.serviceId.optional(),
  tokenPrefix: queueFields.tokenPrefix.default('QF'),
  capacity: queueFields.capacity.default(100),
  joinCutoffTime: queueFields.joinCutoffTime.optional(),
  avgServiceMinutes: queueFields.avgServiceMinutes.default(10),
  approachingThreshold: queueFields.approachingThreshold.default(3),
  allowSameDayJoin: queueFields.allowSameDayJoin.default(true),
  advanceBookingDays: queueFields.advanceBookingDays.default(0),
  advanceBookingQuota: queueFields.advanceBookingQuota.optional(),
});

const updateQueueBody = z.object(queueFields).partial();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

// ─────────────── Public reads ───────────────

queueRouter.get('/', async (req, res) => {
  const q = parse(
    z.object({
      organizationId: uuid.optional(),
      doctorId: uuid.optional(),
      serviceId: uuid.optional(),
    }),
    req.query,
  );
  const queues = await prisma.queue.findMany({
    where: { isArchived: false, organizationId: q.organizationId, doctorId: q.doctorId, serviceId: q.serviceId, organization: { isActive: true } },
    select: { id: true },
    orderBy: { name: 'asc' },
    take: 100,
  });
  res.json({ items: await Promise.all(queues.map((x) => getSnapshot(x.id))) });
});

queueRouter.get('/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await getSnapshot(id));
});

/** Live status: public snapshot plus, when signed in, the caller's own position. */
queueRouter.get('/:id/status', optionalAuth, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const [snapshot, mine] = await Promise.all([getSnapshot(id), req.user ? getMyEntry(id, req.user.id) : null]);
  res.json({ snapshot, myEntry: mine });
});

// ─────────────── Patient ───────────────

queueRouter.get('/:id/me', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ myEntry: await getMyEntry(id, currentUser(req).id) });
});

queueRouter.post('/:id/join', authenticate, requireRole('PATIENT'), joinLimiter, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.status(201).json(await svc.joinQueue(id, currentUser(req).id));
});

queueRouter.delete('/:id/leave', authenticate, requireRole('PATIENT'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await svc.leaveQueue(id, currentUser(req).id));
});

// ─────────────── Advance booking ───────────────

/** Bookable days with remaining places and estimated times (plus the caller's bookings when signed in). */
queueRouter.get('/:id/booking-slots', optionalAuth, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await svc.getBookingSlots(id, req.user?.role === 'PATIENT' ? req.user.id : undefined));
});

queueRouter.post('/:id/bookings', authenticate, requireRole('PATIENT'), joinLimiter, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { date } = parse(z.object({ date: isoDate }), req.body);
  res.status(201).json(await svc.bookAppointment(id, currentUser(req).id, date));
});

queueRouter.delete('/:id/bookings/:entryId', authenticate, requireRole('PATIENT'), async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  res.json(await svc.cancelBooking(id, currentUser(req).id, entryId));
});

// ─────────────── Queue management (doctor / staff / admin) ───────────────

const manage = Router({ mergeParams: true });
manage.use(authenticate, async (req, _res, next) => {
  const { id } = parse(idParams, req.params);
  await assertCanManageQueue(currentUser(req), id);
  next();
});

manage.get('/staff', async (req, res) => {
  res.json(await getStaffView(qid(req)));
});

manage.post('/open', async (req, res) => {
  const user = currentUser(req);
  const { override } = parse(z.object({ override: z.boolean().optional() }), req.body ?? {});
  const queue = await prisma.queue.findUniqueOrThrow({ where: { id: qid(req) }, select: { doctor: { select: { userId: true } } } });
  const result = await svc.openQueue(qid(req), user.id, { override, actorIsDoctor: queue.doctor?.userId === user.id });
  await auditFrom(req, { action: 'queue.open', entityType: 'queue', entityId: qid(req), meta: { override } });
  res.json(result);
});

manage.post('/pause', async (req, res) => {
  res.json(await svc.pauseQueue(qid(req), currentUser(req).id));
});

manage.post('/resume', async (req, res) => {
  res.json(await svc.resumeQueue(qid(req), currentUser(req).id));
});

manage.post('/close', async (req, res) => {
  const result = await svc.closeQueue(qid(req), currentUser(req).id);
  await auditFrom(req, { action: 'queue.close', entityType: 'queue', entityId: qid(req) });
  res.json(result);
});

manage.post('/next', async (req, res) => {
  res.json(await svc.callNext(qid(req), currentUser(req).id));
});

manage.post('/complete', async (req, res) => {
  res.json(await svc.completeCurrent(qid(req), currentUser(req).id));
});

manage.get('/entries/:entryId', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    include: {
      patient: { include: { user: { select: { fullName: true, phone: true, email: true } } } },
      events: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { fullName: true } } } },
      queue: { select: { organizationId: true } },
    },
  });
  if (!entry || entry.queueId !== id) throw notFound('Queue entry');
  const previousVisits = await prisma.queueEntry.findMany({
    where: { patientId: entry.patientId, status: 'COMPLETED', id: { not: entry.id }, queue: { organizationId: entry.queue.organizationId } },
    select: { id: true, tokenLabel: true, completedAt: true, queue: { select: { name: true } } },
    orderBy: { completedAt: 'desc' },
    take: 10,
  });
  await auditFrom(req, { action: 'patient.view', entityType: 'queue_entry', entityId: entryId });
  res.json({
    id: entry.id,
    tokenLabel: entry.tokenLabel,
    status: entry.status,
    priority: entry.priority,
    skipCount: entry.skipCount,
    note: entry.note,
    joinedAt: entry.joinedAt,
    calledAt: entry.calledAt,
    completedAt: entry.completedAt,
    patient: {
      name: entry.patient.user.fullName,
      phone: entry.patient.user.phone,
      // Patients added at reception have an internal placeholder address, not a real email.
      email: entry.patient.user.email.endsWith('@walkin.qfree.local') ? null : entry.patient.user.email,
      addedAtReception: entry.source === 'RECEPTION',
      dateOfBirth: entry.patient.dateOfBirth,
      gender: entry.patient.gender,
    },
    timeline: entry.events.map((e) => ({ type: e.type, at: e.createdAt, by: e.actor?.fullName ?? 'System', meta: e.meta })),
    previousVisits,
  });
});

manage.post('/entries/:entryId/call', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  res.json(await svc.callEntry(id, entryId, currentUser(req).id));
});

manage.post('/entries/:entryId/skip', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().max(200).optional() }), req.body ?? {});
  res.json(await svc.skipEntry(id, entryId, currentUser(req).id, reason));
});

/** Call a patient who missed their turn (the doctor decides when, normally after the active queue). */
manage.post('/entries/:entryId/recall', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  res.json(await svc.recallEntry(id, entryId, currentUser(req).id));
});

/** On-the-spot patient added by doctor or reception. */
manage.post('/walk-ins', async (req, res) => {
  const body = parse(
    z.object({
      fullName: z.string().trim().min(2).max(100),
      phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone number').optional(),
      overrideLimit: z.boolean().optional(),
    }),
    req.body,
  );
  const result = await svc.addWalkIn(qid(req), currentUser(req).id, body);
  await auditFrom(req, { action: 'queue.walk_in_added', entityType: 'queue', entityId: qid(req), meta: { token: result.tokenLabel } });
  res.status(201).json(result);
});

/** Stop / reopen new patients for today without closing the queue. */
manage.post('/joins/stop', async (req, res) => {
  res.json(await svc.setJoinsOpen(qid(req), currentUser(req).id, false));
});

manage.post('/joins/reopen', async (req, res) => {
  res.json(await svc.setJoinsOpen(qid(req), currentUser(req).id, true));
});

/** Upcoming advance bookings, grouped by day. */
manage.get('/bookings', async (req, res) => {
  const id = qid(req);
  const rows = await prisma.queueEntry.findMany({
    where: { queueId: id, status: 'BOOKED' },
    orderBy: [{ sessionDate: 'asc' }, { tokenNumber: 'asc' }],
    take: 500,
    select: { id: true, tokenLabel: true, tokenNumber: true, sessionDate: true, joinedAt: true, patient: { select: { user: { select: { fullName: true, phone: true } } } } },
  });
  const days = new Map<string, { date: string; bookings: { id: string; tokenLabel: string; bookedAt: Date; patient: { name: string; phone: string | null } }[] }>();
  for (const r of rows) {
    const day = days.get(r.sessionDate) ?? { date: r.sessionDate, bookings: [] };
    day.bookings.push({ id: r.id, tokenLabel: r.tokenLabel, bookedAt: r.joinedAt, patient: { name: r.patient.user.fullName, phone: r.patient.user.phone } });
    days.set(r.sessionDate, day);
  }
  res.json({ days: [...days.values()] });
});

manage.post('/entries/:entryId/no-show', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  res.json(await svc.markNoShow(id, entryId, currentUser(req).id));
});

manage.post('/entries/:entryId/cancel', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body ?? {});
  res.json(await svc.cancelEntry(id, entryId, currentUser(req).id, reason));
});

manage.post('/entries/:entryId/priority', async (req, res) => {
  const { id, entryId } = parse(entryParams, req.params);
  const body = parse(
    z.object({ priority: z.enum(['NORMAL', 'PRIORITY', 'EMERGENCY']), reason: z.string().trim().min(3).max(200) }),
    req.body ?? {},
  );
  res.json(await svc.setPriority(id, entryId, body.priority, body.reason, currentUser(req).id));
});

/** Past sessions: entries by date (defaults to all dates, newest first). */
manage.get('/history', async (req, res) => {
  const q = parse(pagination.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const where = { queueId: qid(req), ...(q.date ? { sessionDate: q.date } : {}) };
  const [items, total] = await Promise.all([
    prisma.queueEntry.findMany({
      where,
      orderBy: [{ sessionDate: 'desc' }, { tokenNumber: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { patient: { select: { user: { select: { fullName: true } } } } },
    }),
    prisma.queueEntry.count({ where }),
  ]);
  res.json(
    paged(
      items.map(({ patient, ...e }) => ({ ...e, patientName: patient.user.fullName })),
      total,
      q.page,
      q.pageSize,
    ),
  );
});

manage.get('/events', async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const events = await prisma.queueEvent.findMany({
    where: { queueId: qid(req) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { fullName: true } }, entry: { select: { tokenLabel: true } } },
  });
  res.json({
    items: events.map((e) => ({ id: e.id, type: e.type, at: e.createdAt, by: e.actor?.fullName ?? 'System', token: e.entry?.tokenLabel ?? null, meta: e.meta })),
  });
});

queueRouter.use('/:id', manage);

// ─────────────── Queue configuration ───────────────

async function assertCanConfigure(userId: string, role: string, organizationId: string, doctorId?: string | null) {
  const user = { id: userId, role: role as never };
  if (await isOrgStaff(user, organizationId, ['OWNER', 'MANAGER'])) return;
  const ownDoctorId = await myDoctorId(userId);
  if (ownDoctorId && doctorId === ownDoctorId) return;
  throw forbidden('Only organization managers (or the doctor for their own queue) can configure queues');
}

async function assertProvidersBelong(organizationId: string, doctorId?: string | null, serviceId?: string | null) {
  if (doctorId) {
    const d = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { organizationId: true } });
    if (!d || d.organizationId !== organizationId) throw badRequest('Doctor does not belong to this organization');
  }
  if (serviceId) {
    const s = await prisma.service.findUnique({ where: { id: serviceId }, select: { organizationId: true } });
    if (!s || s.organizationId !== organizationId) throw badRequest('Service does not belong to this organization');
  }
}

queueRouter.post('/', authenticate, requireRole('DOCTOR', 'ORG_ADMIN', 'ADMIN'), async (req, res) => {
  const user = currentUser(req);
  const body = parse(createQueueBody, req.body);
  if (!body.doctorId && !body.serviceId) throw badRequest('A queue must serve a doctor or a service');
  await assertCanConfigure(user.id, user.role, body.organizationId, body.doctorId);
  await assertProvidersBelong(body.organizationId, body.doctorId, body.serviceId);
  const queue = await prisma.queue.create({
    data: {
      organizationId: body.organizationId,
      doctorId: body.doctorId ?? null,
      serviceId: body.serviceId ?? null,
      name: body.name,
      tokenPrefix: body.tokenPrefix,
      capacity: body.capacity,
      joinCutoffTime: body.joinCutoffTime ?? null,
      avgServiceSeconds: Math.round(body.avgServiceMinutes * 60),
      approachingThreshold: body.approachingThreshold,
      allowSameDayJoin: body.allowSameDayJoin,
      advanceBookingDays: body.advanceBookingDays,
      advanceBookingQuota: body.advanceBookingQuota ?? null,
    },
  });
  await auditFrom(req, { action: 'queue.create', entityType: 'queue', entityId: queue.id });
  res.status(201).json(await getSnapshot(queue.id));
});

queueRouter.patch('/:id', authenticate, async (req, res) => {
  const user = currentUser(req);
  const { id } = parse(idParams, req.params);
  const existing = await prisma.queue.findUnique({ where: { id } });
  if (!existing || existing.isArchived) throw notFound('Queue');
  const body = parse(updateQueueBody, req.body);
  await assertCanConfigure(user.id, user.role, existing.organizationId, existing.doctorId);
  await assertProvidersBelong(existing.organizationId, body.doctorId, body.serviceId);
  const { avgServiceMinutes, ...fields } = body;
  await prisma.queue.update({
    where: { id },
    data: {
      ...fields,
      ...(avgServiceMinutes ? { avgServiceSeconds: Math.round(avgServiceMinutes * 60) } : {}),
    },
  });
  await auditFrom(req, { action: 'queue.update', entityType: 'queue', entityId: id, meta: body });
  await publishQueue(id);
  res.json(await getSnapshot(id));
});

queueRouter.delete('/:id', authenticate, async (req, res) => {
  const user = currentUser(req);
  const { id } = parse(idParams, req.params);
  const existing = await prisma.queue.findUnique({ where: { id } });
  if (!existing || existing.isArchived) throw notFound('Queue');
  await assertCanConfigure(user.id, user.role, existing.organizationId, existing.doctorId);
  if (existing.status !== 'CLOSED') throw conflict('Close the queue before archiving it', 'QUEUE_NOT_CLOSED');
  await prisma.queue.update({ where: { id }, data: { isArchived: true } });
  await auditFrom(req, { action: 'queue.archive', entityType: 'queue', entityId: id });
  res.status(204).end();
});
