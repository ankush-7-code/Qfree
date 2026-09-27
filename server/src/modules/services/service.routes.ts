import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { paged, pagination, parse } from '../../lib/validate.js';

/** Public search across all organizations' services (lab tests, diagnostics, consultations). */
export const serviceRouter = Router();

serviceRouter.get('/', async (req, res) => {
  const q = parse(
    pagination.extend({
      q: z.string().trim().max(100).optional(),
      category: z.enum(['CONSULTATION', 'LAB_TEST', 'DIAGNOSTIC', 'PROCEDURE', 'OTHER']).optional(),
      city: z.string().trim().max(80).optional(),
    }),
    req.query,
  );
  const where = {
    isActive: true,
    category: q.category,
    organization: { isActive: true, ...(q.city ? { city: { equals: q.city, mode: 'insensitive' as const } } : {}) },
    ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true, type: true, city: true } },
        queues: { where: { isArchived: false }, select: { id: true, status: true } },
      },
      orderBy: { name: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.service.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});
