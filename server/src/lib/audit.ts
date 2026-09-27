import type { Request } from 'express';
import { prisma, type Db } from './prisma.js';
import { logger } from './logger.js';

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/** Append an audit record. Never throws: auditing must not break the request. */
export async function audit(input: AuditInput, db: Db = prisma) {
  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        ip: input.ip ?? null,
        meta: (input.meta ?? undefined) as object | undefined,
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit log');
  }
}

export const auditFrom = (req: Request, input: Omit<AuditInput, 'actorId' | 'ip'>) =>
  audit({ ...input, actorId: req.user?.id ?? null, ip: req.ip ?? null });
