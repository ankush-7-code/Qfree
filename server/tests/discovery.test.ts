import { beforeAll, describe, expect, it } from 'vitest';
import { api, makeAdmin, register, resetDb, setupOpenQueue } from './helpers.js';

beforeAll(resetDb);

const names = (res: { body: { items: { name: string }[] } }) => res.body.items.map((d) => d.name);

describe('doctor discovery', () => {
  it('lists a newly registered doctor before they join any clinic', async () => {
    await register('DOCTOR', { fullName: 'Dr. Fresh Signup' });
    const res = await api().get('/api/doctors').query({ q: 'Fresh' });
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Dr. Fresh Signup']);
  });

  it('city filter only matches doctors whose clinic is in that city', async () => {
    const doc = await register('DOCTOR', { fullName: 'Dr. Kashmir Valley' });
    expect(names(await api().get('/api/doctors').query({ city: 'Srinagar' }))).toEqual([]);

    await api()
      .post('/api/organizations')
      .set(doc.auth)
      .send({ name: 'Valley Clinic', type: 'CLINIC', address: 'Boulevard Road', city: 'Srinagar' })
      .expect(201);
    expect(names(await api().get('/api/doctors').query({ city: 'srinagar' }))).toEqual(['Dr. Kashmir Valley']);
    expect(await api().get('/api/organizations/cities').then((r) => r.body)).toContain('Srinagar');
  });

  it('stores one spelling per city, however it was typed', async () => {
    const doc = await register('DOCTOR', { fullName: 'Dr. Lowercase City' });
    const org = await api()
      .post('/api/organizations')
      .set(doc.auth)
      .send({ name: 'Tawi Clinic', type: 'CLINIC', address: 'Gandhi Nagar', city: '  jammu ' })
      .expect(201);
    expect(org.body.city).toBe('Jammu');
    const other = await register('DOCTOR', { fullName: 'Dr. Upper City' });
    await api().post('/api/organizations').set(other.auth).send({ name: 'Capital Clinic', type: 'CLINIC', address: 'Connaught Place', city: 'NEW  DELHI' }).expect(201);
    const cities = (await api().get('/api/organizations/cities')).body as string[];
    expect(cities.filter((c) => c.toLowerCase() === 'jammu')).toEqual(['Jammu']);
    expect(cities).toContain('New Delhi');
  });

  it('hides doctors of suspended organizations', async () => {
    const doc = await register('DOCTOR', { fullName: 'Dr. Suspended Clinic' });
    const org = await api()
      .post('/api/organizations')
      .set(doc.auth)
      .send({ name: 'Closed Clinic', type: 'CLINIC', address: '1 Road', city: 'Delhi' });
    const admin = await makeAdmin();
    await api().patch(`/api/admin/organizations/${org.body.id}`).set(admin.auth).send({ isActive: false }).expect(200);
    expect(names(await api().get('/api/doctors').query({ q: 'Suspended' }))).toEqual([]);
  });
});

describe('home page showcase', () => {
  it('lists doctors whose queue is live, with real queue numbers', async () => {
    const { queueId } = await setupOpenQueue();
    await api().post(`/api/queues/${queueId}/join`).set((await register()).auth).expect(201);
    const res = await api().get('/api/doctors/featured');
    expect(res.status).toBe(200);
    expect(res.body.anyLive).toBe(true);
    const mine = res.body.items.find((d: { queue: { id: string } }) => d.queue.id === queueId);
    expect(mine).toMatchObject({ live: true, queue: { status: 'OPEN', waitingCount: 1 } });
    expect(res.body.items.every((d: { live: boolean }) => d.live)).toBe(true);
  });
});
