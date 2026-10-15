import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { hashToken, newRefreshToken, signAccessToken } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';
import { mobileSchema } from '../../lib/phone.js';
import { logger } from '../../lib/logger.js';
import { sendEmail, simpleEmail } from '../../lib/mailer.js';

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
    phone: mobileSchema.optional(),
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
  })
  // Everyone signing up gives a mobile number: clinics reach patients and doctors, QFreee reaches clinic/lab owners.
  .refine((d) => !!d.phone, {
    message: 'Mobile number is required',
    path: ['phone'],
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

// ─── Forgot password ───

const RESET_TTL_MS = 30 * 60_000;
const RESETS_PER_HOUR = 3;

export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address') });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), newPassword: passwordSchema });

/**
 * Email a single-use reset link if an active account has this address. The caller always gets the
 * same answer, so the form cannot be used to find out who has an account.
 */
export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, fullName: true, email: true, isActive: true } });
  if (!user?.isActive) return;
  // Limit how many emails one address can receive.
  const recent = await prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
  if (recent >= RESETS_PER_HOUR) return;

  const { token, hash } = newRefreshToken();
  await prisma.$transaction([
    // Only the newest link works.
    prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordReset.create({ data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) } }),
  ]);
  const url = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const { html, text } = simpleEmail({
    greeting: `Hello ${user.fullName},`,
    lines: ['We received a request to reset the password for your QFreee account.', 'Click the button below to choose a new password. The link works for 30 minutes and can be used once.'],
    button: { label: 'Reset my password', url },
    footer: "If you did not ask for this, you can ignore this email — your password stays the same.",
  });
  try {
    await sendEmail({ to: user.email, subject: 'Reset your QFreee password', html, text });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Password reset email failed');
  }
  await audit({ actorId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id });
}

export async function resetPassword(token: string, newPassword: string) {
  const record = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { isActive: true } } } });
  if (!record || record.usedAt || record.expiresAt < new Date() || !record.user.isActive) {
    throw badRequest('This reset link is invalid or has expired. Please ask for a new one.');
  }
  const userId = record.userId;
  await prisma.$transaction([
    prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } }),
    // Sign out everywhere: whoever knew the old password loses access.
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit({ actorId: userId, action: 'auth.password_reset', entityType: 'user', entityId: userId });
}
