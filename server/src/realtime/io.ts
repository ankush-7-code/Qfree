/**
 * Socket.IO server.
 *
 * Rooms
 *   user:{userId}          personal notifications + the user's own queue positions
 *   queue:{queueId}        public snapshot (no patient identities) — anyone may watch
 *   queue-staff:{queueId}  full patient list — doctor / organization staff / admin only
 *   org:{orgId}            snapshots of every queue of an organization — staff only
 *
 * Clients authenticate with the same JWT access token used for REST (handshake.auth.token).
 * Anonymous sockets are allowed but can only watch public queue rooms.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { resolveUser, type AuthUser } from '../middleware/auth.js';
import { canManageQueue, isOrgStaff } from '../modules/access.js';
import { getMyEntry, getSnapshot, getStaffView } from '../modules/queues/queue.state.js';

export const rooms = {
  user: (id: string) => `user:${id}`,
  queue: (id: string) => `queue:${id}`,
  queueStaff: (id: string) => `queue-staff:${id}`,
  org: (id: string) => `org:${id}`,
};

let io: Server | null = null;
export const getIO = () => io;

type Ack = (res: { ok: boolean; error?: string }) => void;
const idSchema = z.string().uuid();

export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: env.corsOrigins, credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token === 'string' && token) {
      const user = await resolveUser(token);
      if (!user) return next(new Error('UNAUTHORIZED'));
      socket.data.user = user;
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as AuthUser | undefined;
    if (user) void socket.join(rooms.user(user.id));

    const guard =
      (handler: (id: string) => Promise<string | null>) =>
      async (rawId: unknown, ack?: Ack) => {
        const parsed = idSchema.safeParse(rawId);
        if (!parsed.success) return ack?.({ ok: false, error: 'INVALID_ID' });
        try {
          const error = await handler(parsed.data);
          ack?.(error ? { ok: false, error } : { ok: true });
        } catch (err) {
          logger.warn({ err }, 'socket handler failed');
          ack?.({ ok: false, error: 'NOT_FOUND' });
        }
      };

    socket.on(
      'queue:watch',
      guard(async (queueId) => {
        const snapshot = await getSnapshot(queueId);
        await socket.join(rooms.queue(queueId));
        socket.emit('queue:snapshot', snapshot);
        if (user) {
          const mine = await getMyEntry(queueId, user.id);
          if (mine) socket.emit('queue:entry', mine);
        }
        return null;
      }),
    );

    socket.on('queue:unwatch', guard(async (queueId) => (await socket.leave(rooms.queue(queueId)), null)));

    socket.on(
      'queue:watch-staff',
      guard(async (queueId) => {
        if (!user || !(await canManageQueue(user, queueId))) return 'FORBIDDEN';
        await socket.join(rooms.queueStaff(queueId));
        socket.emit('queue:staff', await getStaffView(queueId));
        return null;
      }),
    );

    socket.on('queue:unwatch-staff', guard(async (queueId) => (await socket.leave(rooms.queueStaff(queueId)), null)));

    socket.on(
      'org:watch',
      guard(async (orgId) => {
        if (!user || !(await isOrgStaff(user, orgId))) return 'FORBIDDEN';
        await socket.join(rooms.org(orgId));
        return null;
      }),
    );
  });

  return io;
}

/** Drop all live connections of a user (e.g. after an admin deactivates the account). */
export function disconnectUser(userId: string) {
  io?.in(rooms.user(userId)).disconnectSockets(true);
}
