import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { parse } from '../../lib/validate.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import * as auth from './auth.service.js';

export const REFRESH_COOKIE = 'qf_rt';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.isProd,
  // Frontend and API live on different domains in production (e.g. Vercel + Render).
  sameSite: env.isProd ? 'none' : 'lax',
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
});

function sendSession(res: Response, status: number, session: { user: unknown; accessToken: string; refreshToken: string }) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions());
  res.status(status).json({ user: session.user, accessToken: session.accessToken });
}

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = parse(auth.registerSchema, req.body);
  sendSession(res, 201, await auth.register(body, req.ip));
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = parse(auth.loginSchema, req.body);
  sendSession(res, 200, await auth.login(body, req.ip));
});

authRouter.post('/refresh', async (req, res) => {
  try {
    sendSession(res, 200, await auth.refresh(req.cookies?.[REFRESH_COOKIE]));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  await auth.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await auth.getMe(currentUser(req).id));
});

authRouter.post('/change-password', authenticate, authLimiter, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: auth.passwordSchema }), req.body);
  await auth.changePassword(currentUser(req).id, body.currentPassword, body.newPassword);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});
