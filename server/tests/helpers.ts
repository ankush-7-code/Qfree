import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

export const app = createApp();
export const api = () => request(app);

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

export interface Session {
  token: string;
  user: { id: string; email: string; role: string; patient?: { id: string } | null; doctor?: { id: string } | null };
  auth: { Authorization: string };
}

export async function register(role: 'PATIENT' | 'DOCTOR' | 'ORG_ADMIN' = 'PATIENT', extra: Record<string, unknown> = {}): Promise<Session> {
  const email = `${role.toLowerCase()}-${unique()}@test.dev`;
  const res = await api()
    .post('/api/auth/register')
    .send({
      email,
      password: 'Password123',
      fullName: `Test ${role}`,
      role,
      ...(role === 'DOCTOR' ? { doctor: { specialization: 'General Physician' } } : {}),
      ...extra,
    });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, user: res.body.user, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

export async function makeAdmin(): Promise<Session> {
  const s = await register('PATIENT');
  await prisma.user.update({ where: { id: s.user.id }, data: { role: 'ADMIN' } });
  const res = await api().post('/api/auth/login').send({ email: s.user.email, password: 'Password123' });
  return { token: res.body.accessToken, user: res.body.user, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: '00:00', closeTime: '23:59' }));

/** A clinic owned by a doctor, with one open queue for that doctor. */
export async function setupOpenQueue(opts: { capacity?: number; hours?: typeof ALL_DAY } = {}) {
  const doctor = await register('DOCTOR');
  const org = await api()
    .post('/api/organizations')
    .set(doctor.auth)
    .send({ name: `Clinic ${unique()}`, type: 'CLINIC', address: '1 Test Street', city: 'Testville', hours: opts.hours ?? ALL_DAY });
  if (org.status !== 201) throw new Error(`org create failed: ${JSON.stringify(org.body)}`);
  const me = await api().get('/api/auth/me').set(doctor.auth);
  const queue = await api()
    .post('/api/queues')
    .set(doctor.auth)
    .send({ organizationId: org.body.id, doctorId: me.body.doctor.id, name: 'OPD', tokenPrefix: 'QF', capacity: opts.capacity ?? 100, avgServiceMinutes: 10 });
  if (queue.status !== 201) throw new Error(`queue create failed: ${JSON.stringify(queue.body)}`);
  const open = await api().post(`/api/queues/${queue.body.id}/open`).set(doctor.auth).send({ override: true });
  if (open.status !== 200) throw new Error(`open failed: ${JSON.stringify(open.body)}`);
  return { doctor, orgId: org.body.id as string, queueId: queue.body.id as string };
}
