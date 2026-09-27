/** Resource-level authorization shared by REST routes and socket handlers. */
import type { StaffRole } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { forbidden, notFound } from '../lib/errors.js';
import type { AuthUser } from '../middleware/auth.js';

export async function isOrgStaff(user: Pick<AuthUser, 'id' | 'role'>, organizationId: string, roles?: StaffRole[]) {
  if (user.role === 'ADMIN') return true;
  const m = await prisma.staffMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: user.id } },
    select: { staffRole: true },
  });
  return !!m && (!roles || roles.includes(m.staffRole));
}

export async function assertOrgStaff(user: AuthUser, organizationId: string, roles?: StaffRole[]) {
  if (!(await isOrgStaff(user, organizationId, roles))) throw forbidden();
}

/** Admin, organization staff, or the doctor the queue belongs to. */
export async function canManageQueue(user: Pick<AuthUser, 'id' | 'role'>, queueId: string) {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { organizationId: true, doctor: { select: { userId: true } } },
  });
  if (!queue) throw notFound('Queue');
  if (user.role === 'ADMIN') return true;
  if (queue.doctor?.userId === user.id) return true;
  return isOrgStaff(user, queue.organizationId);
}

export async function assertCanManageQueue(user: AuthUser, queueId: string) {
  if (!(await canManageQueue(user, queueId))) throw forbidden('You do not manage this queue');
}

export async function myDoctorId(userId: string) {
  const d = await prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
  return d?.id ?? null;
}

export async function myPatientId(userId: string) {
  const p = await prisma.patient.findUnique({ where: { userId }, select: { id: true } });
  return p?.id ?? null;
}
