import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
  fullName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/** Resolve the user behind an access token. Re-reads the user so deactivation takes effect immediately. */
export async function resolveUser(token: string): Promise<AuthUser | null> {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, email: true, fullName: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, role: user.role, email: user.email, fullName: user.fullName };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const user = await resolveUser(token);
  if (!user) throw unauthorized('Session expired or invalid. Please sign in again.');
  req.user = user;
  next();
}

/** Attach the user if a valid token is present, but allow anonymous access. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (token) req.user = (await resolveUser(token)) ?? undefined;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
