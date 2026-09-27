import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { api, makeAdmin, register, resetDb, setupOpenQueue, type Session } from './helpers.js';

beforeEach(resetDb);

const join = (queueId: string, s: Session) => api().post(`/api/queues/${queueId}/join`).set(s.auth);
const staffView = async (queueId: string, s: Session) => (await api().get(`/api/queues/${queueId}/staff`).set(s.auth)).body;

describe('joining a queue', () => {
  it('issues sequential tokens with position and ETA', async () => {
    const { queueId } = await setupOpenQueue();
    const a = await join(queueId, await register());
    const b = await join(queueId, await register());
    expect(a.status).toBe(201);
    expect(a.body.entry.tokenLabel).toBe('QF-001');
    expect(b.body.entry.tokenLabel).toBe('QF-002');
    expect(b.body.patientsAhead).toBe(1);
    expect(b.body.estimatedWaitMinutes).toBe(10);
  });

  it('prevents duplicate active entries', async () => {
    const { queueId } = await setupOpenQueue();
    const p = await register();
    expect((await join(queueId, p)).status).toBe(201);
    const dup = await join(queueId, p);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_IN_QUEUE');
  });

  it('gives unique tokens under concurrent joins', async () => {
    const { queueId } = await setupOpenQueue();
    const patients = await Promise.all(Array.from({ length: 15 }, () => register()));
    const results = await Promise.all(patients.map((p) => join(queueId, p)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const tokens = results.map((r) => r.body.entry.tokenNumber).sort((x, y) => x - y);
    expect(tokens).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('blocks the same patient racing to join twice', async () => {
    const { queueId } = await setupOpenQueue();
    const p = await register();
    const results = await Promise.all([join(queueId, p), join(queueId, p), join(queueId, p)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('enforces capacity', async () => {
    const { queueId } = await setupOpenQueue({ capacity: 2 });
    await join(queueId, await register());
    await join(queueId, await register());
    const full = await join(queueId, await register());
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('QUEUE_FULL');
  });

  it('rejects joins to a closed queue and by non-patients', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    expect((await join(queueId, doctor)).status).toBe(403);
    await api().post(`/api/queues/${queueId}/close`).set(doctor.auth);
    const closed = await join(queueId, await register());
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('QUEUE_CLOSED');
  });

  it('refuses joins while the doctor is unavailable', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await api().patch('/api/doctors/me/availability').set(doctor.auth).send({ isAvailable: false });
    const res = await join(queueId, await register());
    expect(res.body.error.code).toBe('DOCTOR_UNAVAILABLE');
  });
});

describe('serving the queue', () => {
  it('calls patients in order, completes the previous one and updates positions', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const [p1, p2, p3] = await Promise.all([register(), register(), register()]);
    for (const p of [p1, p2, p3]) await join(queueId, p);

    const first = await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    expect(first.body).toEqual({ completed: null, called: 'QF-001' });
    const second = await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    expect(second.body).toEqual({ completed: 'QF-001', called: 'QF-002' });

    const mine = await api().get(`/api/queues/${queueId}/me`).set(p3.auth);
    expect(mine.body.myEntry).toMatchObject({ currentToken: 'QF-002', patientsAhead: 0, phase: 'NEXT' });
    const done = await api().get(`/api/queues/${queueId}/me`).set(p1.auth);
    expect(done.body.myEntry.phase).toBe('DONE');

    const snap = await api().get(`/api/queues/${queueId}`);
    expect(snap.body).toMatchObject({ currentToken: 'QF-002', waitingCount: 1, servedCount: 1 });
  });

  it('returns called: null when nobody is waiting', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const res = await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    expect(res.body.called).toBeNull();
  });

  it('does not call patients while paused', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await join(queueId, await register());
    await api().post(`/api/queues/${queueId}/pause`).set(doctor.auth);
    const res = await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    expect(res.body.error.code).toBe('QUEUE_PAUSED');
    await api().post(`/api/queues/${queueId}/resume`).set(doctor.auth);
    expect((await api().post(`/api/queues/${queueId}/next`).set(doctor.auth)).body.called).toBe('QF-001');
  });

  it('serves emergency patients first; priority requires a reason', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const ps = await Promise.all([register(), register(), register()]);
    for (const p of ps) await join(queueId, p);
    const view = await staffView(queueId, doctor);
    const third = view.waiting[2];

    const noReason = await api().post(`/api/queues/${queueId}/entries/${third.id}/priority`).set(doctor.auth).send({ priority: 'EMERGENCY' });
    expect(noReason.status).toBe(400);

    const ok = await api()
      .post(`/api/queues/${queueId}/entries/${third.id}/priority`)
      .set(doctor.auth)
      .send({ priority: 'EMERGENCY', reason: 'Chest pain' });
    expect(ok.status).toBe(200);
    expect((await api().post(`/api/queues/${queueId}/next`).set(doctor.auth)).body.called).toBe('QF-003');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'queue.priority_changed' } });
    expect(audit?.meta).toMatchObject({ to: 'EMERGENCY', reason: 'Chest pain' });
  });

  it('skips an absent patient, re-queues them behind the grace positions, then marks no-show', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const ps = await Promise.all(Array.from({ length: 5 }, () => register()));
    for (const p of ps) await join(queueId, p);

    await api().post(`/api/queues/${queueId}/next`).set(doctor.auth); // QF-001 serving
    let view = await staffView(queueId, doctor);
    const skipped = await api().post(`/api/queues/${queueId}/entries/${view.serving.id}/skip`).set(doctor.auth).send({ reason: 'Not present' });
    expect(skipped.body.skipped).toBe('QF-001');

    view = await staffView(queueId, doctor);
    expect(view.serving).toBeNull();
    expect(view.skipped.map((e: { tokenLabel: string }) => e.tokenLabel)).toEqual(['QF-001']);

    await api().post(`/api/queues/${queueId}/entries/${view.skipped[0].id}/requeue`).set(doctor.auth);
    view = await staffView(queueId, doctor);
    expect(view.waiting.map((e: { tokenLabel: string }) => e.tokenLabel)).toEqual(['QF-002', 'QF-003', 'QF-001', 'QF-004', 'QF-005']);

    const again = await api().post(`/api/queues/${queueId}/entries/${view.waiting[2].id}/skip`).set(doctor.auth).send({});
    expect(again.status).toBe(200);
    const noShow = await api().post(`/api/queues/${queueId}/entries/${view.waiting[2].id}/no-show`).set(doctor.auth);
    expect(noShow.body.noShow).toBe('QF-001');
  });

  it('lets a waiting patient leave but not while being served', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const [p1, p2] = await Promise.all([register(), register()]);
    await join(queueId, p1);
    await join(queueId, p2);
    await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    expect((await api().delete(`/api/queues/${queueId}/leave`).set(p1.auth)).body.error.code).toBe('BEING_SERVED');
    expect((await api().delete(`/api/queues/${queueId}/leave`).set(p2.auth)).body.status).toBe('CANCELLED');
    // After leaving, the patient may join again with a new token.
    expect((await join(queueId, p2)).body.entry.tokenLabel).toBe('QF-003');
  });

  it('closing the queue cancels waiting patients and notifies them', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const p = await register();
    await join(queueId, p);
    await api().post(`/api/queues/${queueId}/close`).set(doctor.auth);
    const mine = await api().get(`/api/queues/${queueId}/me`).set(p.auth);
    expect(mine.body.myEntry.entry.status).toBe('CANCELLED');
    const notes = await api().get('/api/notifications').set(p.auth);
    expect(notes.body.items.map((n: { type: string }) => n.type)).toContain('QUEUE_CLOSED');
  });

  it('records every transition in the queue event log', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    await join(queueId, await register());
    await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    await api().post(`/api/queues/${queueId}/complete`).set(doctor.auth);
    const events = await api().get(`/api/queues/${queueId}/events`).set(doctor.auth);
    expect(events.body.items.map((e: { type: string }) => e.type).reverse()).toEqual(['OPENED', 'JOINED', 'CALLED', 'COMPLETED']);
  });
});

describe('opening hours and authorization', () => {
  it('refuses to open outside operating hours unless overridden', async () => {
    const closedAllWeek = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: '00:00', closeTime: '23:59', isClosed: true }));
    const { queueId, doctor } = await setupOpenQueue({ hours: closedAllWeek });
    await api().post(`/api/queues/${queueId}/close`).set(doctor.auth);
    const refused = await api().post(`/api/queues/${queueId}/open`).set(doctor.auth).send({});
    expect(refused.body.error.code).toBe('OUTSIDE_HOURS');
    const forced = await api().post(`/api/queues/${queueId}/open`).set(doctor.auth).send({ override: true });
    expect(forced.body.status).toBe('OPEN');
  });

  it('only the queue owner, org staff or admins can manage a queue', async () => {
    const { queueId } = await setupOpenQueue();
    const patient = await register();
    const otherDoctor = await register('DOCTOR');
    const admin = await makeAdmin();
    expect((await api().post(`/api/queues/${queueId}/next`).set(patient.auth)).status).toBe(403);
    expect((await api().post(`/api/queues/${queueId}/next`).set(otherDoctor.auth)).status).toBe(403);
    expect((await api().get(`/api/queues/${queueId}/staff`).set(otherDoctor.auth)).status).toBe(403);
    expect((await api().post(`/api/queues/${queueId}/next`).set(admin.auth)).status).toBe(200);
    expect((await api().post(`/api/queues/${queueId}/next`)).status).toBe(401);
  });

  it('public snapshots never expose patient identities', async () => {
    const { queueId } = await setupOpenQueue();
    const p = await register('PATIENT', { fullName: 'Very Private Person', phone: '+91 99999 00000' });
    await join(queueId, p);
    const pub = JSON.stringify((await api().get(`/api/queues/${queueId}`)).body);
    expect(pub).not.toContain('Very Private Person');
    expect(pub).not.toContain('99999');
    expect(pub).not.toContain(p.user.email);
  });

  it('deactivated users lose access immediately', async () => {
    const admin = await makeAdmin();
    const p = await register();
    await api().patch(`/api/admin/users/${p.user.id}`).set(admin.auth).send({ isActive: false });
    expect((await api().get('/api/auth/me').set(p.auth)).status).toBe(401);
  });
});

describe('analytics', () => {
  it('summarises served, cancelled and wait times', async () => {
    const { queueId, doctor } = await setupOpenQueue();
    const [p1, p2] = await Promise.all([register(), register()]);
    await join(queueId, p1);
    await join(queueId, p2);
    await api().post(`/api/queues/${queueId}/next`).set(doctor.auth);
    await api().delete(`/api/queues/${queueId}/leave`).set(p2.auth);
    await api().post(`/api/queues/${queueId}/complete`).set(doctor.auth);

    const res = await api().get('/api/analytics/doctor').set(doctor.auth);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 2, served: 1, cancelled: 1 });
    expect(res.body.peakHours).toHaveLength(24);
    expect((await api().get('/api/analytics/platform').set(doctor.auth)).status).toBe(403);
  });
});
