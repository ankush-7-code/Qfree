import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const message = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } };
const skip = () => env.isTest;

export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message, skip });

/** Brute-force protection for credential endpoints. */
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message, skip });

/** Prevents a single client hammering queue joins. */
export const joinLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message, skip });
