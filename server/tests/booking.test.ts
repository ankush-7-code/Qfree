import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { localDate } from '../src/lib/time.js';
import { addDays } from '../src/modules/queues/queue.logic.js';
import { expireStaleBookings } from '../src/modules/queues/queue.service.js';
import { api, register, resetDb, setupOpenQueue, type Session } from './helpers.js';

beforeEach(resetDb);

const TZ = 'Asia/Kolkata'; // default organization timezone used by the helpers
const today = () => localDate(TZ);
const join = (queueId: string, s: Session) => api().post(`/api/queues/${queueId}/join`).set(s.auth);
const configure = (queueId: string, doctor: Session, body: Record<string, unknown>) =>
  api().patch(`/api/queues/${queueId}`).set(doctor.auth).send(body).expect(200);
const book = (queueId: string, s: Session, date: string) => api().post(`/api/queues/${queueId}/bookings`).set(s.auth).send({ date });

describe('closing rules', () => {
  it('stops new patients at the daily limit', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { capacity: 2 });
    await join(queueId, await register());
    await join(queueId, await register());
    const third = await join(queueId, await register());
    expect(third.body.error.code).toBe('QUEUE_FULL');
    const snap = (await api().get(`/api/queues/${queueId}`)).body;
    expect(snap).toMatchObject({ isAcceptingPatients: false, joinBlock: 'FULL' });
  });

  it('stops new patients after the cutoff time; the doctor can reopen', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { joinCutoffTime: '00:00' }); // always past
    expect((await join(queueId, await register())).body.error.code).toBe('CUTOFF_PASSED');

    await api().post(`/api/queues/${queueId}/joins/reopen`).set(doctor.auth).expect(200);
    expect((await join(queueId, await register())).status).toBe(201);
  });

  it('lets the doctor stop new patients without closing the queue', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const inLine = await register();
    await join(queueId, inLine);
    await api().post(`/api/queues/${queueId}/joins/stop`).set(doctor.auth).expect(200);
    expect((await join(queueId, await register())).body.error.code).toBe('JOINS_STOPPED');
    // Patients already in line are still served.
    expect((await api().post(`/api/queues/${queueId}/next`).set(doctor.auth)).body.called).toBe('QF-001');
    await api().post(`/api/queues/${queueId}/joins/reopen`).set(doctor.auth).expect(200);
    expect((await join(queueId, await register())).status).toBe(201);
  });

  it('only staff control new-patient intake', async () => {
    const { queueId } = await setupOpenQueue();
    const patient = await register();
    expect((await api().post(`/api/queues/${queueId}/joins/stop`).set(patient.auth)).status).toBe(403);
  });

  it('updating one setting leaves the others unchanged', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { capacity: 7, advanceBookingDays: 4, joinCutoffTime: '16:00' });
    await configure(queueId, doctor, { name: 'Renamed OPD' });
    const q = await prisma.queue.findUniqueOrThrow({ where: { id: queueId } });
    expect(q).toMatchObject({ name: 'Renamed OPD', capacity: 7, advanceBookingDays: 4, joinCutoffTime: '16:00', tokenPrefix: 'QF', avgServiceSeconds: 600 });
  });
});

describe('on-the-spot patients', () => {
  it('reception adds a patient without an account, even when online joining is off', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { allowSameDayJoin: false });
    expect((await join(queueId, await register())).body.error.code).toBe('SAME_DAY_DISABLED');

    const walkIn = await api().post(`/api/queues/${queueId}/walk-ins`).set(doctor.auth).send({ fullName: 'Kamla Devi', phone: '+91 98765 43210' });
    expect(walkIn.status).toBe(201);
    expect(walkIn.body).toMatchObject({ tokenLabel: 'QF-001', patientsAhead: 0 });

    const view = (await api().get(`/api/queues/${queueId}/staff`).set(doctor.auth)).body;
    expect(view.waiting[0]).toMatchObject({ tokenLabel: 'QF-001', source: 'RECEPTION', patient: { name: 'Kamla Devi' } });
    const details = (await api().get(`/api/queues/${queueId}/entries/${walkIn.body.entryId}`).set(doctor.auth)).body;
    expect(details.patient).toMatchObject({ email: null, addedAtReception: true });
  });

  it('respects the daily limit unless reception explicitly overrides it', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { capacity: 1 });
    await api().post(`/api/queues/${queueId}/walk-ins`).set(doctor.auth).send({ fullName: 'First Patient' }).expect(201);
    const over = await api().post(`/api/queues/${queueId}/walk-ins`).set(doctor.auth).send({ fullName: 'Second Patient' });
    expect(over.body.error.code).toBe('QUEUE_FULL');
    await api().post(`/api/queues/${queueId}/walk-ins`).set(doctor.auth).send({ fullName: 'Second Patient', overrideLimit: true }).expect(201);
    expect(await prisma.auditLog.count({ where: { action: 'queue.walk_in_over_limit' } })).toBe(1);
  });

  it('patients cannot add walk-ins', async () => {
    const { queueId } = await setupOpenQueue();
    const p = await register();
    expect((await api().post(`/api/queues/${queueId}/walk-ins`).set(p.auth).send({ fullName: 'Someone Else' })).status).toBe(403);
  });
});

describe('advance booking', () => {
  it('is off until the doctor sets a booking window', async () => {
    const { queueId } = await setupOpenQueue();
    const res = await book(queueId, await register(), addDays(today(), 1));
    expect(res.body.error.code).toBe('BOOKING_DISABLED');
  });

  it('shows bookable days and issues numbered tokens with estimated times', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { advanceBookingDays: 3, capacity: 20 });
    const tomorrow = addDays(today(), 1);

    const slots = (await api().get(`/api/queues/${queueId}/booking-slots`)).body;
    expect(slots.days.map((d: { date: string }) => d.date)).toEqual([tomorrow, addDays(today(), 2), addDays(today(), 3)]);
    expect(slots.days[0]).toMatchObject({ available: true, booked: 0, remaining: 20, nextEstimatedTime: '00:00' });

    const [p1, p2] = await Promise.all([register(), register()]);
    const b1 = await book(queueId, p1, tomorrow);
    expect(b1.status).toBe(201);
    expect(b1.body).toMatchObject({ tokenLabel: 'QF-001', date: tomorrow, position: 1, estimatedTime: '00:00' });
    expect((await book(queueId, p2, tomorrow)).body).toMatchObject({ tokenLabel: 'QF-002', estimatedTime: '00:10' });

    expect((await book(queueId, p1, tomorrow)).body.error.code).toBe('ALREADY_BOOKED');
    expect((await book(queueId, p1, today())).body.error.code).toBe('OUTSIDE_BOOKING_WINDOW');
    expect((await book(queueId, p1, addDays(today(), 4))).body.error.code).toBe('OUTSIDE_BOOKING_WINDOW');

    const mine = (await api().get('/api/patients/me/bookings').set(p2.auth)).body.items;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ tokenLabel: 'QF-002', date: tomorrow, position: 2, estimatedTime: '00:10' });

    const withMine = (await api().get(`/api/queues/${queueId}/booking-slots`).set(p1.auth)).body;
    expect(withMine.days[0]).toMatchObject({ booked: 2, remaining: 18, myBooking: { tokenLabel: 'QF-001' } });

    const staff = (await api().get(`/api/queues/${queueId}/bookings`).set(doctor.auth)).body;
    expect(staff.days[0].bookings.map((b: { tokenLabel: string }) => b.tokenLabel)).toEqual(['QF-001', 'QF-002']);
  });

  it('keeps places for on-the-spot patients with an advance-booking quota', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { advanceBookingDays: 2, advanceBookingQuota: 1 });
    const tomorrow = addDays(today(), 1);
    await book(queueId, await register(), tomorrow).expect(201);
    expect((await book(queueId, await register(), tomorrow)).body.error.code).toBe('DAY_FULL');
  });

  it('frees the place when a patient cancels', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { advanceBookingDays: 1, capacity: 1 });
    const tomorrow = addDays(today(), 1);
    const p = await register();
    const b = await book(queueId, p, tomorrow);
    expect((await book(queueId, await register(), tomorrow)).body.error.code).toBe('DAY_FULL');
    await api().delete(`/api/queues/${queueId}/bookings/${b.body.entryId}`).set(p.auth).expect(200);
    expect((await book(queueId, await register(), tomorrow)).status).toBe(201);
  });

  it('puts booked patients first in line when that day opens; on-the-spot patients follow', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { advanceBookingDays: 1 });
    const [p1, p2, walkUp] = await Promise.all([register(), register(), register()]);
    await book(queueId, p1, addDays(today(), 1)).expect(201);
    await book(queueId, p2, addDays(today(), 1)).expect(201);

    // Fast-forward: the booked day is "today" and the queue still holds yesterday's session.
    await prisma.queueEntry.updateMany({ where: { queueId, status: 'BOOKED' }, data: { sessionDate: today() } });
    await prisma.queue.update({ where: { id: queueId }, data: { sessionDate: addDays(today(), -1), status: 'CLOSED' } });
    await api().post(`/api/queues/${queueId}/open`).set(doctor.auth).send({ override: true }).expect(200);

    expect((await join(queueId, walkUp)).body.entry.tokenLabel).toBe('QF-003');
    const view = (await api().get(`/api/queues/${queueId}/staff`).set(doctor.auth)).body;
    expect(view.waiting.map((e: { tokenLabel: string; source: string }) => `${e.tokenLabel}:${e.source}`)).toEqual([
      'QF-001:ADVANCE',
      'QF-002:ADVANCE',
      'QF-003:SAME_DAY',
    ]);
    expect((await api().post(`/api/queues/${queueId}/next`).set(doctor.auth)).body.called).toBe('QF-001');
    const notes = (await api().get('/api/notifications').set(p2.auth)).body.items.map((n: { type: string }) => n.type);
    expect(notes).toEqual(expect.arrayContaining(['BOOKED', 'QUEUE_OPENED']));
  });

  it('expires bookings for a day whose queue never opened', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await configure(queueId, doctor, { advanceBookingDays: 1 });
    const p = await register();
    const b = await book(queueId, p, addDays(today(), 1));
    await prisma.queueEntry.update({ where: { id: b.body.entryId }, data: { sessionDate: addDays(today(), -1) } });

    expect(await expireStaleBookings()).toBe(1);
    expect(await prisma.queueEntry.findUniqueOrThrow({ where: { id: b.body.entryId } })).toMatchObject({ status: 'CANCELLED' });
    const notes = (await api().get('/api/notifications').set(p.auth)).body.items.map((n: { type: string }) => n.type);
    expect(notes).toContain('BOOKING_CANCELLED');
  });

  it('shows the doctor’s weekly availability on their public profile', async () => {
    const { doctor } = await setupOpenQueue();
    const me = (await api().get('/api/auth/me').set(doctor.auth)).body;
    const profile = (await api().get(`/api/doctors/${me.doctor.id}`)).body;
    expect(profile.availability.weekly).toHaveLength(7);
    expect(profile.availability.todaySlots).toEqual([{ start: '00:00', end: '23:59' }]);
    expect(profile.organization).toMatchObject({ city: 'Testville', timezone: TZ });
  });
});
