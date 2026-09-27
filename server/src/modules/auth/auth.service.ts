import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, conflict, unauthorized } from '../../lib/errors.js';
import { hashToken, newRefreshToken, signAccessToken } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';

const BCRYPT_COST = env.isTest ? 4 : 12;
const REFRESH_RACE_GRACE_MS = 60_000;
// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('qfree-timing-equaliser', BCRYPT_COST);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: passwordSchema,
    fullName: z.string().trim().min(2).max(100),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone number')
      .optional(),
    role: z.enum(['PATIENT', 'DOCTOR', 'ORG_ADMIN']).default('PATIENT'),
    doctor: z
      .object({
        specialization: z.string().trim().min(2).max(100),
        qualification: z.string().trim().max(200).optional(),
        experienceYears: z.coerce.number().int().min(0).max(70).optional(),
      })
      .optional(),
  })
  .refine((d) => d.role !== 'DOCTOR' || !!d.doctor, {
    message: 'Doctor details (specialization) are required for doctor accounts',
    path: ['doctor'],
  });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      patient: { select: { id: true, dateOfBirth: true, gender: true } },
      doctor: { select: { id: true, organizationId: true, specialization: true } },
      memberships: { include: { organization: { select: { id: true, name: true, type: true } } } },
    },
  });
  if (!user) throw unauthorized();
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt,
    patient: user.patient,
    doctor: user.doctor,
    organizations: user.memberships.map((m) => ({ ...m.organization, staffRole: m.staffRole })),
  };
}

async function issueTokens(user: { id: string; role: z.infer<typeof registerSchema>['role'] | 'ADMIN' }) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refresh = newRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  return { accessToken, refreshToken: refresh.token };
}

export async function register(input: z.infer<typeof registerSchema>, ip?: string) {
  const exists = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (exists) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      phone: input.phone,
      role: input.role,
      ...(input.role === 'PATIENT' ? { patient: { create: {} } } : {}),
      ...(input.role === 'DOCTOR' && input.doctor
        ? {
            doctor: {
              create: {
                specialization: input.doctor.specialization,
                qualification: input.doctor.qualification,
                experienceYears: input.doctor.experienceYears ?? 0,
              },
            },
          }
        : {}),
    },
  });
  await audit({ actorId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id, ip, meta: { role: user.role } });
  const tokens = await issueTokens(user);
  return { user: await getMe(user.id), ...tokens };
}

export async function login(input: z.infer<typeof loginSchema>, ip?: string) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    await audit({ action: 'auth.login_failed', entityType: 'user', entityId: user?.id, ip, meta: { email: input.email } });
    throw unauthorized('Incorrect email or password');
  }
  if (!user.isActive) throw unauthorized('This account has been deactivated. Please contact support.');
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip });
  const tokens = await issueTokens(user);
  return { user: await getMe(user.id), ...tokens };
}

/** Rotate a refresh token. Presenting an already-revoked token revokes every session of that user (theft signal). */
export async function refresh(token: string | undefined) {
  if (!token) throw unauthorized('No session');
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!record) throw unauthorized('Invalid session');
  if (record.revokedAt) {
    // Two tabs refreshing at once present the same token; the loser simply retries with the new cookie.
    if (Date.now() - record.revokedAt.getTime() < REFRESH_RACE_GRACE_MS) {
      throw new AppError(401, 'REFRESH_RACE', 'Session was just refreshed. Retry.');
    }
    await prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ actorId: record.userId, action: 'auth.refresh_reuse_detected', entityType: 'user', entityId: record.userId });
    throw unauthorized('Session expired. Please sign in again.');
  }
  if (record.expiresAt < new Date() || !record.user.isActive) throw unauthorized('Session expired. Please sign in again.');

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  const tokens = await issueTokens(record.user);
  return { user: await getMe(record.userId), ...tokens };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  // Back-dated so a replay after logout is never mistaken for a benign refresh race.
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date(Date.now() - REFRESH_RACE_GRACE_MS) },
  });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw unauthorized('Current password is incorrect');
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit({ actorId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId });
}
