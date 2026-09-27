import { beforeAll, describe, expect, it } from 'vitest';
import { api, makeAdmin, register, resetDb } from './helpers.js';

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
