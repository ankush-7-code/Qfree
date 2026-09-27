import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idParams, parse } from '../../lib/validate.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import { assertCanManageQueue, assertOrgStaff } from '../access.js';
import { computeAnalytics, type AnalyticsRange } from './analytics.service.js';

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeFrom(query: unknown): AnalyticsRange {
  const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional(), bucket: z.enum(['day', 'week', 'month']).default('day') }), query);
  // Session dates are organization-local; UTC+14 is the furthest-ahead zone, so this always includes "today".
  const to = q.to ?? iso(new Date(Date.now() + 14 * 3_600_000));
  const from = q.from ?? iso(new Date(Date.now() - 29 * 86_400_000));
  if (from > to) throw badRequest('"from" must be on or before "to"');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw badRequest('Range cannot exceed one year');
  return { from, to, bucket: q.bucket };
}

analyticsRouter.get('/doctor', requireRole('DOCTOR'), async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { userId: currentUser(req).id }, select: { queues: { select: { id: true } } } });
  if (!doctor) throw notFound('Doctor profile');
  res.json(await computeAnalytics(doctor.queues.map((q) => q.id), rangeFrom(req.query)));
});

analyticsRouter.get('/organizations/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertOrgStaff(currentUser(req), id);
  const queues = await prisma.queue.findMany({ where: { organizationId: id }, select: { id: true } });
  res.json(await computeAnalytics(queues.map((q) => q.id), rangeFrom(req.query)));
});

analyticsRouter.get('/queues/:id', async (req, res) => {
  const { id } = parse(idParams, req.params);
  await assertCanManageQueue(currentUser(req), id);
  res.json(await computeAnalytics([id], rangeFrom(req.query)));
});

analyticsRouter.get('/platform', requireRole('ADMIN'), async (req, res) => {
  res.json(await computeAnalytics(null, rangeFrom(req.query)));
});
