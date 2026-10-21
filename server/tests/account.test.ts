import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { api, register, resetDb, setupOpenQueue } from './helpers.js';

beforeEach(resetDb);

const del = (auth: Record<string, string>, password = 'Password123') => api().post('/api/auth/delete-account').set(auth).send({ password });

describe('delete account', () => {
  it('erases a patient’s personal details, frees their place in line and blocks sign-in', async () => {
    const { queueId } = await setupOpenQueue();
    const patient = await register('PATIENT');
    await api().post(`/api/queues/${queueId}/join`).set(patient.auth).expect(201);

    expect((await del(patient.auth, 'WrongPassword1')).status).toBe(401);
    expect((await del(patient.auth)).status).toBe(204);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: patient.user.id } });
    expect(user).toMatchObject({ fullName: 'Deleted user', phone: null, isActive: false });
    expect(user.email).not.toBe(patient.user.email);
    // The visit stays as an anonymous, cancelled record.
    const entries = await prisma.queueEntry.findMany({ where: { queueId } });
    expect(entries.map((e) => e.status)).toEqual(['CANCELLED']);

    expect((await api().post('/api/auth/login').send({ email: patient.user.email, password: 'Password123' })).status).toBe(401);
    expect((await api().get('/api/auth/me').set(patient.auth)).status).toBe(401);
    // The email can be used for a new account.
    expect((await api().post('/api/auth/register').send({ email: patient.user.email, password: 'Password123', fullName: 'New Me', phone: '98765 00001' })).status).toBe(201);
  });

  it('asks a doctor to close open queues first, then closes their clinic with the account', async () => {
    const { doctor, orgId, queueId } = await setupOpenQueue();
    const blocked = await del(doctor.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Close these queues first: OPD/);

    await api().post(`/api/queues/${queueId}/close`).set(doctor.auth).expect(200);
    expect((await del(doctor.auth)).status).toBe(204);
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).toMatchObject({ isActive: false });
    expect(await prisma.queue.findUniqueOrThrow({ where: { id: queueId } })).toMatchObject({ isArchived: true });
    expect((await api().get('/api/doctors').query({ q: 'Test DOCTOR' })).body.items).toEqual([]);
  });
});

describe('clinic manages its doctors', () => {
  it('edits a doctor’s details and weekly schedule, but only for its own doctors', async () => {
    const { doctor, orgId } = await setupOpenQueue();
    const me = (await api().get('/api/auth/me').set(doctor.auth)).body;
    const doctorId = me.doctor.id as string;
    const base = `/api/organizations/${orgId}/doctors/${doctorId}`;

    const update = await api().patch(base).set(doctor.auth).send({ specialization: 'Paediatrics', experienceYears: 12, phone: '94190 11111', isAvailable: false });
    expect(update.status).toBe(204);
    const details = (await api().get(base).set(doctor.auth)).body;
    expect(details).toMatchObject({ specialization: 'Paediatrics', experienceYears: 12, isAvailable: false, user: { phone: '+91 94190 11111' } });

    const schedule = await api().put(`${base}/schedule`).set(doctor.auth).send([{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00', maxPatients: 30 }]);
    expect(schedule.status).toBe(200);
    expect((await api().get(base).set(doctor.auth)).body.schedules).toEqual([{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00', maxPatients: 30 }]);

    // Another clinic cannot touch this doctor.
    const other = await setupOpenQueue();
    expect((await api().patch(`/api/organizations/${other.orgId}/doctors/${doctorId}`).set(other.doctor.auth).send({ experienceYears: 1 })).status).toBe(404);
    expect((await api().patch(base).set(other.doctor.auth).send({ experienceYears: 1 })).status).toBe(403);
  });
});
