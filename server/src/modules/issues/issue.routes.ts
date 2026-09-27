import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { paged, pagination, parse } from '../../lib/validate.js';
import { authenticate, currentUser } from '../../middleware/auth.js';

/** Any signed-in user can report a problem; administrators triage them in /api/admin/issues. */
export const issueRouter = Router();
issueRouter.use(authenticate);

issueRouter.post('/', async (req, res) => {
  const body = parse(z.object({ subject: z.string().trim().min(3).max(150), description: z.string().trim().min(10).max(4000) }), req.body);
  const issue = await prisma.issue.create({ data: { ...body, reporterId: currentUser(req).id } });
  res.status(201).json(issue);
});

issueRouter.get('/mine', async (req, res) => {
  const q = parse(pagination, req.query);
  const where = { reporterId: currentUser(req).id };
  const [items, total] = await Promise.all([
    prisma.issue.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.issue.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});
