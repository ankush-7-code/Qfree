/**
 * One-time upgrades of the demo data for features added after the demo was first loaded.
 * Each upgrade runs once (tracked in system_settings) and only touches queues owned by the demo
 * organization accounts, never organizations created by real users.
 */
import { prisma } from '../src/lib/prisma.js';
import { bookAppointment } from '../src/modules/queues/queue.service.js';
import { localDate } from '../src/lib/time.js';
import { addDays, dayAvailability, weekdayOf } from '../src/modules/queues/queue.logic.js';
import { TZ } from './demo-lib.js';

const DEMO_OWNERS = ['clinic@qfree.dev', 'lab@qfree.dev'];

async function once(key: string, run: () => Promise<string>) {
  const marker = `demo.upgrade.${key}`;
  if (await prisma.systemSetting.findUnique({ where: { key: marker } })) return null;
  const summary = await run();
  await prisma.systemSetting.create({ data: { key: marker, value: { appliedAt: new Date().toISOString(), summary } } });
  return summary;
}

/** Advance booking + closing rules on demo queues, and a few sample bookings for the coming days. */
async function bookingsAndClosingRules() {
  const queues = await prisma.queue.findMany({
    where: { isArchived: false, organization: { staff: { some: { staffRole: 'OWNER', user: { email: { in: DEMO_OWNERS } } } } } },
    include: { doctor: { include: { user: true, schedules: true } }, organization: { include: { hours: true } } },
  });
  for (const q of queues) {
    await prisma.queue.update({
      where: { id: q.id },
      data: {
        advanceBookingDays: q.doctorId ? 7 : 3,
        advanceBookingQuota: q.doctorId ? Math.round(q.capacity / 2) : null,
        // One demo queue shows the "stop accepting at" rule.
        joinCutoffTime: q.doctor?.user.email === 'dr.mehta@qfree.dev' ? '19:00' : q.joinCutoffTime,
      },
    });
  }

  // Sample bookings on the next consulting days of two popular doctors.
  const patients = await prisma.user.findMany({
    where: { email: { startsWith: 'patient', endsWith: '@qfree.dev' }, role: 'PATIENT' },
    orderBy: { email: 'asc' },
    select: { id: true, email: true },
  });
  const demo = patients.find((p) => p.email === 'patient@qfree.dev');
  const others = patients.filter((p) => p !== demo);
  let booked = 0;
  for (const email of ['dr.sharma@qfree.dev', 'dr.gupta@qfree.dev']) {
    const q = queues.find((x) => x.doctor?.user.email === email);
    if (!q) continue;
    const today = localDate(TZ);
    const days = [1, 2, 3, 4, 5, 6, 7]
      .map((i) => addDays(today, i))
      .filter((d) => dayAvailability(weekdayOf(d), q.organization.hours, q.doctor?.schedules ?? null).length)
      .slice(0, 2);
    for (const [i, day] of days.entries()) {
      const bookers = others.slice(i * 6, i * 6 + 4 + i * 2);
      if (email === 'dr.sharma@qfree.dev' && i === 0 && demo) bookers.push(demo);
      for (const p of bookers) {
        await bookAppointment(q.id, p.id, day).then(() => booked++, () => undefined);
      }
    }
  }
  return `booking enabled on ${queues.length} demo queues, ${booked} sample bookings`;
}

/** A stable, valid-looking demo mobile number derived from the email (demo accounts only). */
export function demoMobile(email: string) {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return `+91 98000 ${String(h).padStart(5, '0')}`;
}

/** Contact numbers became mandatory for doctors and laboratories: fill them in for the demo accounts. */
async function demoPhones() {
  const doctors = await prisma.user.findMany({ where: { role: 'DOCTOR', phone: null, email: { endsWith: '@qfree.dev' } }, select: { id: true, email: true } });
  for (const d of doctors) await prisma.user.update({ where: { id: d.id }, data: { phone: demoMobile(d.email) } });
  const labs = await prisma.organization.findMany({
    where: {
      phone: null,
      type: { in: ['LABORATORY', 'DIAGNOSTIC_CENTER'] },
      staff: { some: { staffRole: 'OWNER', user: { email: { in: DEMO_OWNERS } } } },
    },
    select: { id: true },
  });
  for (const [i, l] of labs.entries()) await prisma.organization.update({ where: { id: l.id }, data: { phone: `+91 20255300${String(11 + i).padStart(2, '0')}` } });
  return `phones added for ${doctors.length} demo doctors and ${labs.length} demo labs`;
}

export async function applyDemoUpgrades() {
  const done = [await once('bookings-v1', bookingsAndClosingRules), await once('phones-v1', demoPhones)];
  return done.filter((d): d is string => d !== null);
}
