/**
 * Notifications are persisted (in-app inbox) and pushed over Socket.IO.
 * Delivery channels are pluggable so SMS / WhatsApp / push can be added later
 * without touching queue logic — register another NotificationChannel.
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { getIO, rooms } from '../../realtime/io.js';

export type NotificationType =
  | 'QUEUE_JOINED'
  | 'TURN_APPROACHING'
  | 'YOUR_TURN'
  | 'SKIPPED'
  | 'REQUEUED'
  | 'CANCELLED'
  | 'QUEUE_PAUSED'
  | 'QUEUE_RESUMED'
  | 'QUEUE_CLOSED'
  | 'PRIORITY_CHANGED'
  | 'QUEUE_OPENED'
  | 'BOOKED'
  | 'BOOKING_CANCELLED'
  | 'RECALLED'
  | 'SYSTEM';

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface NotificationChannel {
  name: string;
  send(notification: NotificationInput & { id: string; createdAt: Date }): Promise<void>;
}

const socketChannel: NotificationChannel = {
  name: 'socket',
  async send(n) {
    getIO()?.to(rooms.user(n.userId)).emit('notification:new', n);
  },
};

const channels: NotificationChannel[] = [socketChannel];

export function registerChannel(channel: NotificationChannel) {
  channels.push(channel);
}

export async function sendNotifications(inputs: NotificationInput[]) {
  if (!inputs.length) return;
  const created = await prisma.notification.createManyAndReturn({
    data: inputs.map((n) => ({ userId: n.userId, type: n.type, title: n.title, body: n.body, data: n.data as object | undefined })),
  });
  for (const n of created) {
    for (const ch of channels) {
      ch.send({ ...n, type: n.type as NotificationType, data: (n.data ?? undefined) as Record<string, unknown> | undefined }).catch(
        (err) => logger.warn({ err, channel: ch.name }, 'notification delivery failed'),
      );
    }
  }
}
