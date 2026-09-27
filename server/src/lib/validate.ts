import { z } from 'zod';

/** Parse untrusted input with a Zod schema; ZodErrors are mapped to HTTP 400 by the error handler. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');

export function paged<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
