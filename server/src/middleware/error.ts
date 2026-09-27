import type { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

interface PrismaLikeError {
  code?: string;
  meta?: { target?: unknown; modelName?: string };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request data', details: z.flattenError(err) },
    });
    return;
  }
  const prismaErr = err as PrismaLikeError;
  if (prismaErr?.code === 'P2002') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these details already exists' } });
    return;
  }
  if (prismaErr?.code === 'P2025') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
}
