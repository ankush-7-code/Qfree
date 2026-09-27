import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { initRealtime } from '../src/realtime/io.js';
import { api, app, register, resetDb, setupOpenQueue } from './helpers.js';

let server: Server;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  await resetDb();
  server = createServer(app);
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((resolve) => server.close(resolve));
});

function client(token?: string) {
  const s = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

function next<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5000);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const emitAck = (socket: Socket, event: string, arg: unknown) =>
  new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit(event, arg, resolve));

describe('real-time updates', () => {
  it('pushes position changes to the patient when the doctor calls the next patient', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const patients = await Promise.all(Array.from({ length: 5 }, () => register()));
    for (const p of patients) await api().post(`/api/queues/${queueId}/join`).set(p.auth);
    const last = patients[4];

    const patientSocket = client(last.token);
    const initial = next<{ patientsAhead: number }>(patientSocket, 'queue:entry');
    expect((await emitAck(patientSocket, 'queue:watch', queueId)).ok).toBe(true);
    expect((await initial).patientsAhead).toBe(4);

    // Crossing the approaching threshold (3 ahead) triggers both a position update and a notification.
    const moved = next<{ patientsAhead: number; currentToken: string; phase: string }>(patientSocket, 'queue:entry', (e) => e.currentToken === 'QF-001');
    const notified = next<{ type: string; body: string }>(patientSocket, 'notification:new', (n) => n.type === 'TURN_APPROACHING');
    await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);

    expect(await moved).toMatchObject({ patientsAhead: 3, phase: 'APPROACHING' });
    expect((await notified).body).toContain('3 patients ahead');
  });

  it('broadcasts anonymous-safe snapshots to public watchers', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const watcher = client();
    const first = next<{ waitingCount: number }>(watcher, 'queue:snapshot');
    await emitAck(watcher, 'queue:watch', queueId);
    expect((await first).waitingCount).toBe(0);

    const updated = next<{ waitingCount: number }>(watcher, 'queue:snapshot', (s) => s.waitingCount === 1);
    await api().post(`/api/queues/${queueId}/join`).set((await register()).auth);
    expect((await updated).waitingCount).toBe(1);

    const paused = next<{ status: string }>(watcher, 'queue:snapshot', (s) => s.status === 'PAUSED');
    await api().post(`/api/queues/${queueId}/pause`).set(doctor.auth);
    expect((await paused).status).toBe('PAUSED');
  });

  it('only lets staff subscribe to the staff room', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const patient = await register();
    expect((await emitAck(client(patient.token), 'queue:watch-staff', queueId)).error).toBe('FORBIDDEN');
    expect((await emitAck(client(), 'queue:watch-staff', queueId)).error).toBe('FORBIDDEN');

    const staffSocket = client(doctor.token);
    const view = next<{ waiting: unknown[] }>(staffSocket, 'queue:staff');
    expect((await emitAck(staffSocket, 'queue:watch-staff', queueId)).ok).toBe(true);
    expect((await view).waiting).toEqual([]);
  });

  it('rejects sockets with an invalid token', async () => {
    const s = client('not-a-token');
    const err = await new Promise<Error>((resolve) => s.on('connect_error', resolve));
    expect(err.message).toBe('UNAUTHORIZED');
  });
});
