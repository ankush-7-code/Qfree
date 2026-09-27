import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hhmm, idParams, paged, pagination, parse, uuid } from '../../lib/validate.js';
import { isValidTimeZone } from '../../lib/time.js';
import { auditFrom } from '../../lib/audit.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { assertOrgStaff } from '../access.js';
import { hashPassword, passwordSchema } from '../auth/auth.service.js';
import { getSnapshot } from '../queues/queue.state.js';

export const organizationRouter = Router();

/** "jammu" → "Jammu", "new  delhi" → "New Delhi" (matches PostgreSQL initcap used in the data migration). */
export function cityName(raw: string) {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

const orgType = z.enum(['CLINIC', 'LABORATORY', 'HOSPITAL', 'DIAGNOSTIC_CENTER']);

const orgBody = z.object({
  name: z.string().trim().min(2).max(120),
  type: orgType,
  description: z.string().trim().max(1000).optional(),
  address: z.string().trim().min(3).max(300),
  city: z.string().trim().min(2).max(80).transform(cityName),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  timezone: z.string().refine(isValidTimeZone, 'Unknown timezone').default('Asia/Kolkata'),
});

const hoursBody = z
  .array(
    z
      .object({ dayOfWeek: z.number().int().min(0).max(6), openTime: hhmm, closeTime: hhmm, isClosed: z.boolean().default(false) })
      .refine((h) => h.isClosed || h.openTime < h.closeTime, 'openTime must be before closeTime'),
  )
  .max(7)
  .refine((rows) => new Set(rows.map((r) => r.dayOfWeek)).size === rows.length, 'Duplicate day');

const publicSelect = {
  id: true,
  name: true,
  type: true,
  description: true,
  address: true,
  city: true,
  phone: true,
  email: true,
  timezone: true,
  isVerified: true,
} as const;

// ─────────────── Public ───────────────

organizationRouter.get('/', async (req, res) => {
  const q = parse(pagination.extend({ q: z.string().trim().max(100).optional(), type: orgType.optional(), city: z.string().trim().max(80).optional() }), req.query);
  const where = {
    isActive: true,
    type: q.type,
    ...(q.city ? { city: { equals: q.city, mode: 'insensitive' as const } } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' as const } },
            { city: { contains: q.q, mode: 'insensitive' as const } },
            { services: { some: { name: { contains: q.q, mode: 'insensitive' as const }, isActive: true } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      select: { ...publicSelect, _count: { select: { doctors: true, services: true, queues: { where: { isArchived: false } } } } },
      orderBy: [{ isVerified: 'desc' }, { name: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.organization.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

organizationRouter.get('/cities', async (_req, res) => {
  const rows = await prisma.organization.findMany({ where: { isActive: true }, distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } });
  // One entry per city regardless of how it was typed.
  res.json([...new Set(rows.map((r) => cityName(r.city)))].sort());
});

organizationRouter.get('/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const org = await prisma.organization.findFirst({
    where: { id, isActive: true },
    select: {
      ...publicSelect,
      hours: { orderBy: { dayOfWeek: 'asc' }, select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true } },
      doctors: {
        select: { id: true, specialization: true, qualification: true, experienceYears: true, isAvailable: true, user: { select: { fullName: true } } },
      },
      services: { where: { isActive: true }, select: { id: true, name: true, category: true, description: true, durationMinutes: true, price: true } },
      queues: { where: { isArchived: false }, select: { id: true } },
    },
  });
  if (!org) throw notFound('Organization');
  const { queues, doctors, ...rest } = org;
  res.json({
    ...rest,
    doctors: doctors.map(({ user, ...d }) => ({ ...d, name: user.fullName })),
    queues: await Promise.all(queues.map((q) => getSnapshot(q.id))),
  });
});

// ─────────────── Management ───────────────

organizationRouter.get('/mine/list', authenticate, async (req, res) => {
  const user = currentUser(req);
  const memberships = await prisma.staffMember.findMany({
    where: { userId: user.id },
    include: { organization: { select: { ...publicSelect, isActive: true } } },
  });
  res.json(memberships.map((m) => ({ ...m.organization, staffRole: m.staffRole })));
});

/** Organization admins create clinics/labs; doctors may create their own practice. */
organizationRouter.post('/', authenticate, requireRole('ORG_ADMIN', 'DOCTOR', 'ADMIN'), async (req, res) => {
  const user = currentUser(req);
  const body = parse(orgBody.extend({ hours: hoursBody.optional() }), req.body);
  const org = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: {
        name: body.name,
        type: body.type,
        description: body.description,
        address: body.address,
        city: body.city,
        phone: body.phone,
        email: body.email,
        timezone: body.timezone,
        staff: { create: { userId: user.id, staffRole: 'OWNER' } },
        hours: body.hours ? { create: body.hours } : undefined,
      },
    });
    if (user.role === 'DOCTOR') {
      await tx.doctor.updateMany({ where: { userId: user.id, organizationId: null }, data: { organizationId: created.id } });
    }
    return created;
  });
  await auditFrom(req, { action: 'organization.create', entityType: 'organization', entityId: org.id });
  res.status(201).json(org);
});

organizationRouter.patch('/:id', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const body = parse(orgBody.partial(), req.body);
  const org = await prisma.organization.update({ where: { id }, data: body });
  await auditFrom(req, { action: 'organization.update', entityType: 'organization', entityId: id, meta: body });
  res.json(org);
});

organizationRouter.get('/:id/manage', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id);
  const org = await prisma.organization.findUnique({
    where: { id },
    include: {
      hours: { orderBy: { dayOfWeek: 'asc' } },
      doctors: { include: { user: { select: { fullName: true, email: true, phone: true } } } },
      services: { orderBy: { name: 'asc' } },
      queues: { where: { isArchived: false }, select: { id: true } },
      staff: { include: { user: { select: { id: true, fullName: true, email: true, phone: true } } } },
    },
  });
  if (!org) throw notFound('Organization');
  const { queues, ...rest } = org;
  res.json({ ...rest, queues: await Promise.all(queues.map((q) => getSnapshot(q.id))) });
});

organizationRouter.put('/:id/hours', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const rows = parse(hoursBody, req.body);
  await prisma.$transaction([
    prisma.operatingHours.deleteMany({ where: { organizationId: id } }),
    prisma.operatingHours.createMany({ data: rows.map((r) => ({ ...r, organizationId: id })) }),
  ]);
  await auditFrom(req, { action: 'organization.hours_update', entityType: 'organization', entityId: id });
  res.json(await prisma.operatingHours.findMany({ where: { organizationId: id }, orderBy: { dayOfWeek: 'asc' } }));
});

// ─── Staff ───

const staffBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(100).optional(),
  password: passwordSchema.optional(),
  staffRole: z.enum(['MANAGER', 'RECEPTIONIST']).default('RECEPTIONIST'),
});

/** Add a staff member: links an existing organization account, or creates one when a password is supplied. */
organizationRouter.post('/:id/staff', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const body = parse(staffBody, req.body);
  let user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.role !== 'ORG_ADMIN') throw conflict('That email belongs to a non-staff account', 'ROLE_MISMATCH');
  if (!user) {
    if (!body.password || !body.fullName) throw badRequest('No account with that email. Provide fullName and password to create one.');
    user = await prisma.user.create({
      data: { email: body.email, fullName: body.fullName, passwordHash: await hashPassword(body.password), role: 'ORG_ADMIN' },
    });
  }
  const member = await prisma.staffMember.create({
    data: { organizationId: id, userId: user.id, staffRole: body.staffRole },
    include: { user: { select: { id: true, fullName: true, email: true, phone: true } } },
  });
  await auditFrom(req, { action: 'organization.staff_add', entityType: 'organization', entityId: id, meta: { userId: user.id, staffRole: body.staffRole } });
  res.status(201).json(member);
});

organizationRouter.delete('/:id/staff/:memberId', authenticate, async (req, res) => {
  const { id, memberId } = parse(z.object({ id: uuid, memberId: uuid }), req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const member = await prisma.staffMember.findUnique({ where: { id: memberId } });
  if (!member || member.organizationId !== id) throw notFound('Staff member');
  if (member.staffRole === 'OWNER') throw conflict('The owner cannot be removed', 'OWNER_REQUIRED');
  await prisma.staffMember.delete({ where: { id: memberId } });
  await auditFrom(req, { action: 'organization.staff_remove', entityType: 'organization', entityId: id, meta: { userId: member.userId } });
  res.status(204).end();
});

// ─── Doctors ───

const doctorLinkBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(100).optional(),
  password: passwordSchema.optional(),
  specialization: z.string().trim().min(2).max(100).optional(),
  qualification: z.string().trim().max(200).optional(),
  experienceYears: z.coerce.number().int().min(0).max(70).optional(),
  consultationMinutes: z.coerce.number().int().min(1).max(120).optional(),
});

/** Attach a doctor to the organization; creates the doctor account if it does not exist yet. */
organizationRouter.post('/:id/doctors', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const body = parse(doctorLinkBody, req.body);
  const existing = await prisma.user.findUnique({ where: { email: body.email }, include: { doctor: true } });
  let doctorId: string;
  if (existing) {
    if (!existing.doctor) throw conflict('That email does not belong to a doctor account', 'ROLE_MISMATCH');
    if (existing.doctor.organizationId && existing.doctor.organizationId !== id) {
      throw conflict('This doctor is already linked to another organization', 'DOCTOR_LINKED');
    }
    doctorId = existing.doctor.id;
    await prisma.doctor.update({ where: { id: doctorId }, data: { organizationId: id } });
  } else {
    if (!body.password || !body.fullName || !body.specialization) {
      throw badRequest('No doctor with that email. Provide fullName, password and specialization to create one.');
    }
    const user = await prisma.user.create({
      data: {
        email: body.email,
        fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        role: 'DOCTOR',
        doctor: {
          create: {
            organizationId: id,
            specialization: body.specialization,
            qualification: body.qualification,
            experienceYears: body.experienceYears ?? 0,
            consultationMinutes: body.consultationMinutes ?? 10,
          },
        },
      },
      include: { doctor: true },
    });
    doctorId = user.doctor!.id;
  }
  await auditFrom(req, { action: 'organization.doctor_link', entityType: 'organization', entityId: id, meta: { doctorId } });
  res.status(201).json(await prisma.doctor.findUnique({ where: { id: doctorId }, include: { user: { select: { fullName: true, email: true } } } }));
});

organizationRouter.delete('/:id/doctors/:doctorId', authenticate, async (req, res) => {
  const { id, doctorId } = parse(z.object({ id: uuid, doctorId: uuid }), req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  if (!doctor || doctor.organizationId !== id) throw notFound('Doctor');
  const openQueues = await prisma.queue.count({ where: { doctorId, status: { not: 'CLOSED' } } });
  if (openQueues) throw conflict("Close this doctor's queues before removing them", 'QUEUE_OPEN');
  await prisma.$transaction([
    prisma.queue.updateMany({ where: { doctorId }, data: { isArchived: true } }),
    prisma.doctor.update({ where: { id: doctorId }, data: { organizationId: null } }),
  ]);
  await auditFrom(req, { action: 'organization.doctor_unlink', entityType: 'organization', entityId: id, meta: { doctorId } });
  res.status(204).end();
});

// ─── Services ───

const serviceBody = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.enum(['CONSULTATION', 'LAB_TEST', 'DIAGNOSTIC', 'PROCEDURE', 'OTHER']),
  description: z.string().trim().max(1000).optional(),
  durationMinutes: z.coerce.number().int().min(1).max(480).default(10),
  price: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  isActive: z.boolean().optional(),
});

organizationRouter.post('/:id/services', authenticate, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const body = parse(serviceBody, req.body);
  const service = await prisma.service.create({ data: { ...body, organizationId: id } });
  await auditFrom(req, { action: 'service.create', entityType: 'service', entityId: service.id });
  res.status(201).json(service);
});

organizationRouter.patch('/:id/services/:serviceId', authenticate, async (req, res) => {
  const { id, serviceId } = parse(z.object({ id: uuid, serviceId: uuid }), req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const existing = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!existing || existing.organizationId !== id) throw notFound('Service');
  const body = parse(serviceBody.partial(), req.body);
  const service = await prisma.service.update({ where: { id: serviceId }, data: body });
  await auditFrom(req, { action: 'service.update', entityType: 'service', entityId: serviceId, meta: body });
  res.json(service);
});

organizationRouter.delete('/:id/services/:serviceId', authenticate, async (req, res) => {
  const { id, serviceId } = parse(z.object({ id: uuid, serviceId: uuid }), req.params);
  await assertOrgStaff(currentUser(req), id, ['OWNER', 'MANAGER']);
  const existing = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!existing || existing.organizationId !== id) throw notFound('Service');
  // Soft-delete keeps historical queue data intact.
  await prisma.service.update({ where: { id: serviceId }, data: { isActive: false } });
  await auditFrom(req, { action: 'service.deactivate', entityType: 'service', entityId: serviceId });
  res.status(204).end();
});
