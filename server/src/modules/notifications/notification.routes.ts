import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { idParams, paged, pagination, parse } from '../../lib/validate.js';
import { authenticate, currentUser } from '../../middleware/auth.js';

export const notificationRouter = Router();
notificationRouter.use(authenticate);

notificationRouter.get('/', async (req, res) => {
  const q = parse(pagination.extend({ unread: z.enum(['true', 'false']).optional() }), req.query);
  const userId = currentUser(req).id;
  const where = { userId, ...(q.unread === 'true' ? { readAt: null } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  res.json({ ...paged(items, total, q.page, q.pageSize), unread });
});

notificationRouter.get('/unread-count', async (req, res) => {
  res.json({ unread: await prisma.notification.count({ where: { userId: currentUser(req).id, readAt: null } }) });
});

notificationRouter.post('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  res.status(204).end();
});

notificationRouter.patch('/:id/read', async (req, res) => {
  const { id } = parse(idParams, req.params);
  const result = await prisma.notification.updateMany({ where: { id, userId: currentUser(req).id }, data: { readAt: new Date() } });
  if (!result.count) throw notFound('Notification');
  res.status(204).end();
});
