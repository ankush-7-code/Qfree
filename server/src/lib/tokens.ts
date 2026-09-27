import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Role } from '../generated/prisma/client.js';

export interface AccessPayload {
  sub: string;
  role: Role;
}

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
    issuer: 'qfree',
    audience: 'qfree-api',
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'qfree', audience: 'qfree-api' });
  if (typeof decoded === 'string' || !decoded.sub) throw new Error('Malformed token');
  return { sub: decoded.sub, role: (decoded as jwt.JwtPayload & AccessPayload).role };
}

/** Refresh tokens are opaque random strings; only their SHA-256 hash is stored. */
export function newRefreshToken() {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string) =>
  crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
