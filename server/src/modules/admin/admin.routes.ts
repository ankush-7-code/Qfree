import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idParams, paged, pagination, parse } from '../../lib/validate.js';
import { auditFrom } from '../../lib/audit.js';
import { getSettings, settingsSchema, updateSettings } from '../../lib/settings.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { disconnectUser } from '../../realtime/io.js';
import { getSnapshot } from '../queues/queue.state.js';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('ADMIN'));

const role = z.enum(['PATIENT', 'DOCTOR', 'ORG_ADMIN', 'ADMIN']);
const contains = (q?: string) => (q ? { contains: q, mode: 'insensitive' as const } : undefined);

adminRouter.get('/overview', async (_req, res) => {
  // Organizations span time zones, so "today" is a rolling 24 hours platform-wide.
  const since = new Date(Date.now() - 86_400_000);
  const [usersByRole, orgsByType, openQueues, pausedQueues, entriesToday, waitingNow, openIssues, recentAudit] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], _count: true }),
    prisma.organization.groupBy({ by: ['type'], _count: true }),
    prisma.queue.count({ where: { status: 'OPEN', isArchived: false } }),
    prisma.queue.count({ where: { status: 'PAUSED', isArchived: false } }),
    prisma.queueEntry.count({ where: { joinedAt: { gte: since } } }),
    prisma.queueEntry.count({ where: { status: 'WAITING' } }),
    prisma.issue.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { actor: { select: { fullName: true, email: true } } } }),
  ]);
  res.json({
    usersByRole: Object.fromEntries(usersByRole.map((r) => [r.role, r._count])),
    organizationsByType: Object.fromEntries(orgsByType.map((r) => [r.type, r._count])),
    openQueues,
    pausedQueues,
    entriesToday,
    waitingNow,
    openIssues,
    recentAudit,
  });
});

// ─── Users ───

adminRouter.get('/users', async (req, res) => {
  const q = parse(pagination.extend({ q: z.string().trim().max(100).optional(), role: role.optional(), active: z.enum(['true', 'false']).optional() }), req.query);
  const where = {
    role: q.role,
    ...(q.active ? { isActive: q.active === 'true' } : {}),
    ...(q.q ? { OR: [{ fullName: contains(q.q) }, { email: contains(q.q) }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: { id: true, email: true, fullName: true, phone: true, role: true, isActive: true, lastLoginAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

adminRouter.patch('/users/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ isActive: z.boolean().optional(), role: role.optional() }), req.body);
  if (id === currentUser(req).id) throw badRequest('You cannot change your own role or status');
  const user = await prisma.user.findUnique({ where: { id }, include: { doctor: true, patient: true } });
  if (!user) throw notFound('User');
  if (body.role === 'DOCTOR' && !user.doctor) throw badRequest('This user has no doctor profile');
  if (body.role === 'PATIENT' && !user.patient) await prisma.patient.create({ data: { userId: id } });

  const updated = await prisma.user.update({
    where: { id },
    data: body,
    select: { id: true, email: true, fullName: true, role: true, isActive: true },
  });
  if (body.isActive === false || (body.role && body.role !== user.role)) {
    await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    disconnectUser(id);
  }
  await auditFrom(req, { action: 'admin.user_update', entityType: 'user', entityId: id, meta: body });
  res.json(updated);
});

// ─── Providers ───

adminRouter.get('/doctors', async (req, res) => {
  const q = parse(pagination.extend({ q: z.string().trim().max(100).optional() }), req.query);
  const where = q.q ? { OR: [{ user: { fullName: contains(q.q) } }, { specialization: contains(q.q) }] } : {};
  const [items, total] = await Promise.all([
    prisma.doctor.findMany({
      where,
      include: { user: { select: { id: true, fullName: true, email: true, isActive: true } }, organization: { select: { id: true, name: true } }, _count: { select: { queues: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.doctor.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

adminRouter.get('/organizations', async (req, res) => {
  const q = parse(
    pagination.extend({ q: z.string().trim().max(100).optional(), type: z.enum(['CLINIC', 'LABORATORY', 'HOSPITAL', 'DIAGNOSTIC_CENTER']).optional() }),
    req.query,
  );
  const where = { type: q.type, ...(q.q ? { OR: [{ name: contains(q.q) }, { city: contains(q.q) }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      include: { _count: { select: { doctors: true, services: true, queues: true, staff: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.organization.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

adminRouter.patch('/organizations/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ isVerified: z.boolean().optional(), isActive: z.boolean().optional() }), req.body);
  const org = await prisma.organization.update({ where: { id }, data: body });
  await auditFrom(req, { action: 'admin.organization_update', entityType: 'organization', entityId: id, meta: body });
  res.json(org);
});

adminRouter.get('/services', async (req, res) => {
  const q = parse(pagination.extend({ q: z.string().trim().max(100).optional() }), req.query);
  const where = q.q ? { name: contains(q.q) } : {};
  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      include: { organization: { select: { id: true, name: true, type: true } } },
      orderBy: { name: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.service.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

adminRouter.get('/queues', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['OPEN', 'PAUSED', 'CLOSED']).optional() }), req.query);
  const queues = await prisma.queue.findMany({ where: { isArchived: false, status: q.status }, select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 200 });
  res.json({ items: await Promise.all(queues.map((x) => getSnapshot(x.id))) });
});

// ─── Oversight ───

adminRouter.get('/audit-logs', async (req, res) => {
  const q = parse(
    pagination.extend({ action: z.string().trim().max(100).optional(), entityType: z.string().trim().max(50).optional(), actorId: z.string().uuid().optional() }),
    req.query,
  );
  const where = { entityType: q.entityType, actorId: q.actorId, ...(q.action ? { action: { startsWith: q.action } } : {}) };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { fullName: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

adminRouter.get('/issues', async (req, res) => {
  const q = parse(pagination.extend({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional() }), req.query);
  const where = { status: q.status };
  const [items, total] = await Promise.all([
    prisma.issue.findMany({
      where,
      include: { reporter: { select: { fullName: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.issue.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

adminRouter.patch('/issues/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(
    z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(), adminNote: z.string().trim().max(2000).optional() }),
    req.body,
  );
  const issue = await prisma.issue.update({ where: { id }, data: body });
  await auditFrom(req, { action: 'admin.issue_update', entityType: 'issue', entityId: id, meta: body });
  res.json(issue);
});

adminRouter.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

adminRouter.put('/settings', async (req, res) => {
  const body = parse(settingsSchema.partial(), req.body);
  const settings = await updateSettings(body);
  await auditFrom(req, { action: 'admin.settings_update', entityType: 'settings', meta: body });
  res.json(settings);
});
