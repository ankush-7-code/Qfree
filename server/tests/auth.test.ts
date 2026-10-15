import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { api, register, resetDb } from './helpers.js';

beforeAll(resetDb);

const cookieFrom = (res: { headers: Record<string, unknown> }) =>
  ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('qf_rt='))?.split(';')[0];

describe('auth', () => {
  it('registers a patient with a patient profile and never returns the password hash', async () => {
    const res = await api().post('/api/auth/register').send({ email: 'Asha@Example.com', password: 'Password123', fullName: 'Asha Rao', phone: '98765 43210' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'asha@example.com', role: 'PATIENT' });
    expect(res.body.user.patient).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(cookieFrom(res)).toBeTruthy();
  });

  it('rejects duplicate emails, weak passwords and admin self-registration', async () => {
    const dup = await api().post('/api/auth/register').send({ email: 'asha@example.com', password: 'Password123', fullName: 'Dup', phone: '98765 43219' });
    expect(dup.status).toBe(409);
    const weak = await api().post('/api/auth/register').send({ email: 'weak@example.com', password: 'short', fullName: 'Weak' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    const admin = await api().post('/api/auth/register').send({ email: 'x@example.com', password: 'Password123', fullName: 'X', role: 'ADMIN' });
    expect(admin.status).toBe(400);
  });

  it('requires doctor details for doctor accounts', async () => {
    const res = await api().post('/api/auth/register').send({ email: 'doc@example.com', password: 'Password123', fullName: 'Doc', role: 'DOCTOR' });
    expect(res.status).toBe(400);
    const ok = await register('DOCTOR');
    expect(ok.user.doctor).toBeTruthy();
  });

  it('logs in, returns the same error for wrong password and unknown email', async () => {
    const ok = await api().post('/api/auth/login').send({ email: 'asha@example.com', password: 'Password123' });
    expect(ok.status).toBe(200);
    const wrong = await api().post('/api/auth/login').send({ email: 'asha@example.com', password: 'nope12345' });
    const unknown = await api().post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope12345' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('protects /me and accepts a valid bearer token', async () => {
    expect((await api().get('/api/auth/me')).status).toBe(401);
    expect((await api().get('/api/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const s = await register();
    const me = await api().get('/api/auth/me').set(s.auth);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(s.user.id);
  });

  it('rotates refresh tokens and revokes all sessions when an old token is replayed', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'asha@example.com', password: 'Password123' });
    const first = cookieFrom(login)!;
    const r1 = await api().post('/api/auth/refresh').set('Cookie', first);
    expect(r1.status).toBe(200);
    const second = cookieFrom(r1)!;
    expect(second).not.toBe(first);

    // Immediate replay looks like two tabs racing: rejected as retryable, other sessions untouched.
    const race = await api().post('/api/auth/refresh').set('Cookie', first);
    expect(race.status).toBe(401);
    expect(race.body.error.code).toBe('REFRESH_RACE');

    // A replay long after rotation is treated as theft: every session of the user is revoked.
    await prisma.refreshToken.updateMany({ where: { revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 3_600_000) } });
    const replay = await api().post('/api/auth/refresh').set('Cookie', first);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHORIZED');
    expect((await api().post('/api/auth/refresh').set('Cookie', second)).status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const login = await api().post('/api/auth/login').send({ email: 'asha@example.com', password: 'Password123' });
    const cookie = cookieFrom(login)!;
    expect((await api().post('/api/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await api().post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('contact numbers', () => {
  const reg = (body: Record<string, unknown>) =>
    api().post('/api/auth/register').send({ password: 'Password123', fullName: 'Phone Test', ...body });

  it('requires a valid Indian mobile for patients and doctors, stored in one format', async () => {
    const missing = await reg({ email: 'nophone@example.com' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fieldErrors.phone).toBeTruthy();
    expect((await reg({ email: 'bad1@example.com', phone: '12345' })).status).toBe(400);
    expect((await reg({ email: 'bad2@example.com', phone: '0191 245 0011' })).status).toBe(400); // landline is not a mobile
    expect((await reg({ email: 'doc@phone.dev', role: 'DOCTOR', doctor: { specialization: 'ENT' } })).status).toBe(400);

    for (const [email, phone] of [['ok1@example.com', '98765 43210'], ['ok2@example.com', '+91-98765-43211'], ['ok3@example.com', '09876543212']]) {
      const ok = await reg({ email, phone });
      expect(ok.status).toBe(201);
      expect(ok.body.user.phone).toMatch(/^\+91 9876[5-6] 4321\d$/);
    }
  });

  it('requires a mobile for clinic / lab accounts too', async () => {
    const missing = await reg({ email: 'staff@example.com', role: 'ORG_ADMIN' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fieldErrors.phone).toEqual(['Mobile number is required']);
    expect((await reg({ email: 'staff@example.com', role: 'ORG_ADMIN', phone: '94190 12345' })).status).toBe(201);
  });

  it('requires a contact number for laboratories and diagnostic centres, not for clinics', async () => {
    const owner = await reg({ email: 'labowner@example.com', role: 'ORG_ADMIN', phone: '94190 54321' });
    const auth = { Authorization: `Bearer ${owner.body.accessToken}` };
    const base = { address: '7 MG Road', city: 'Jammu' };
    expect((await api().post('/api/organizations').set(auth).send({ ...base, name: 'Lab A', type: 'LABORATORY' })).status).toBe(400);
    expect((await api().post('/api/organizations').set(auth).send({ ...base, name: 'Diag A', type: 'DIAGNOSTIC_CENTER' })).status).toBe(400);
    const lab = await api().post('/api/organizations').set(auth).send({ ...base, name: 'Lab B', type: 'LABORATORY', phone: '0191 245 0011' });
    expect(lab.status).toBe(201);
    expect(lab.body.phone).toBe('+91 1912450011');
    expect((await api().post('/api/organizations').set(auth).send({ ...base, name: 'Clinic A', type: 'CLINIC' })).status).toBe(201);

    // Renaming keeps the existing number; the timezone is not reset by a partial update.
    const renamed = await api().patch(`/api/organizations/${lab.body.id}`).set(auth).send({ name: 'Lab B Renamed' });
    expect(renamed.body).toMatchObject({ name: 'Lab B Renamed', phone: '+91 1912450011', timezone: 'Asia/Kolkata' });
  });
});
