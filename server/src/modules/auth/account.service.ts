import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { cancelEntry } from '../queues/queue.service.js';
import { publishQueue } from '../../realtime/publish.js';

/** Upcoming or waiting entries in these queues are cancelled (with a message to the patient). */
async function cancelOpenEntries(where: { patientId?: string; queueId?: { in: string[] } }, actorId: string, reason: string) {
  const entries = await prisma.queueEntry.findMany({ where: { ...where, status: { in: ['BOOKED', 'WAITING', 'SKIPPED'] } }, select: { id: true, queueId: true } });
  for (const e of entries) await cancelEntry(e.queueId, e.id, actorId, reason);
}

async function retireQueues(queueIds: string[], actorId: string, reason: string) {
  if (!queueIds.length) return;
  await cancelOpenEntries({ queueId: { in: queueIds } }, actorId, reason);
  await prisma.queue.updateMany({ where: { id: { in: queueIds } }, data: { isArchived: true } });
  await Promise.all(queueIds.map((id) => publishQueue(id)));
}

/**
 * Permanently delete a user's account. Personal details (name, email, mobile, password, date of birth)
 * are erased and the person can no longer sign in. Past visits stay as anonymous records ("Deleted user")
 * so clinics' counts and reports remain correct.
 */
export async function deleteAccount(userId: string, password: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      patient: { select: { id: true } },
      doctor: { select: { id: true, queues: { where: { isArchived: false }, select: { id: true, name: true, status: true } } } },
      memberships: { include: { organization: { select: { id: true, name: true, isActive: true, queues: { where: { isArchived: false }, select: { id: true, name: true, status: true } }, staff: { where: { staffRole: 'OWNER' }, select: { userId: true } } } } } },
    },
  });
  if (user.role === 'ADMIN') throw forbidden('The administrator account cannot be deleted');
  if (!(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('Password is incorrect');

  if (user.patient) {
    const serving = await prisma.queueEntry.count({ where: { patientId: user.patient.id, status: 'SERVING' } });
    if (serving) throw conflict('You are being seen right now. Please delete your account after your visit.', 'BEING_SERVED');
  }

  // Organizations this person alone owns are closed along with the account.
  const ownedAlone = user.memberships
    .filter((m) => m.staffRole === 'OWNER' && m.organization.isActive && m.organization.staff.every((s) => s.userId === userId))
    .map((m) => m.organization);
  const openQueues = [...(user.doctor?.queues ?? []), ...ownedAlone.flatMap((o) => o.queues)].filter((q) => q.status !== 'CLOSED');
  if (openQueues.length) {
    throw conflict(`Close these queues first: ${[...new Set(openQueues.map((q) => q.name))].join(', ')}.`, 'QUEUE_OPEN');
  }

  if (user.patient) await cancelOpenEntries({ patientId: user.patient.id }, userId, 'The patient deleted their QFreee account');
  if (user.doctor) {
    await retireQueues(user.doctor.queues.map((q) => q.id), userId, 'This doctor is no longer on QFreee');
  }
  for (const org of ownedAlone) {
    await retireQueues(org.queues.map((q) => q.id), userId, `${org.name} is no longer on QFreee`);
  }

  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 4);
  await prisma.$transaction([
    ...(ownedAlone.length ? [prisma.organization.updateMany({ where: { id: { in: ownedAlone.map((o) => o.id) } }, data: { isActive: false } })] : []),
    prisma.staffMember.deleteMany({ where: { userId } }),
    ...(user.doctor
      ? [prisma.doctor.update({ where: { id: user.doctor.id }, data: { organizationId: null, isAvailable: false, bio: null, qualification: null } }), prisma.doctorSchedule.deleteMany({ where: { doctorId: user.doctor.id } })]
      : []),
    ...(user.patient ? [prisma.patient.update({ where: { id: user.patient.id }, data: { dateOfBirth: null, gender: null } })] : []),
    prisma.notification.deleteMany({ where: { userId } }),
    prisma.passwordReset.deleteMany({ where: { userId } }),
    prisma.refreshToken.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { email: `deleted-${userId}@deleted.qfreee.com`, fullName: 'Deleted user', phone: null, passwordHash: unusable, isActive: false },
    }),
  ]);
  await audit({ actorId: userId, action: 'auth.account_deleted', entityType: 'user', entityId: userId, meta: { role: user.role, closedOrganizations: ownedAlone.map((o) => o.id) } });
}
