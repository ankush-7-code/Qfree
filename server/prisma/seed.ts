/**
 * Demo data. Wipes the database and recreates:
 *  - 1 admin, 2 organization admins, 5 doctors, 40 patients (password for all: Password123)
 *  - 3 organizations (clinic, hospital, laboratory) with hours, services and queues
 *  - Today's live session for Dr. Sharma: QF-001…023 served, QF-024 serving, QF-025…030 waiting
 *    → the demo patient (patient@qfree.dev) joins as QF-031 with 6 patients ahead
 *  - 30 days of simulated history (single-server queue simulation) for analytics
 */
import bcrypt from 'bcryptjs';
import type { EntryStatus, OrganizationType, Prisma } from '../src/generated/prisma/client.js';
import { prisma } from '../src/lib/prisma.js';
import { localDate } from '../src/lib/time.js';
import { formatToken, sortKeyForToken } from '../src/modules/queues/queue.logic.js';

const TZ = 'Asia/Kolkata';
const PASSWORD = 'Password123';
const MIN = 60_000;

// Deterministic PRNG so every seed produces the same data.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const between = (a: number, b: number) => a + rand() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const normal = (mean: number, sd: number) => {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ananya', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Saanvi', 'Arjun', 'Meera', 'Kabir', 'Priya', 'Rahul', 'Sneha', 'Vikram', 'Neha', 'Aditi', 'Karan', 'Pooja'];
const LAST = ['Verma', 'Gupta', 'Singh', 'Patel', 'Reddy', 'Nair', 'Joshi', 'Das', 'Kapoor', 'Menon', 'Rao', 'Bose', 'Chopra', 'Pillai'];

async function wipe() {
  const tables = [
    'queue_events', 'appointments', 'queue_entries', 'queues', 'doctor_schedules', 'services', 'operating_hours',
    'staff_members', 'doctors', 'patients', 'organizations', 'notifications', 'refresh_tokens', 'audit_logs', 'issues',
    'system_settings', 'users',
  ];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

async function main() {
  // --auto (used at server start): seed only when SEED_DEMO=true and the database is still empty.
  const auto = process.argv.includes('--auto');
  if (auto && process.env.SEED_DEMO !== 'true') return;

  // The seed wipes every table: refuse on a database that already has users unless explicitly asked.
  const existing = await prisma.user.count();
  if (existing > 0) {
    if (auto) {
      console.log('Demo seed skipped: database already has data.');
      return;
    }
    if (!process.argv.includes('--reset')) {
      console.error(`Database already has ${existing} users. Re-run with --reset to wipe it and load demo data.`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('Seeding QFree demo data…');
  await wipe();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  // On a public deployment the admin must not share the published demo password.
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
  const adminHash = adminPassword ? await bcrypt.hash(adminPassword, 12) : passwordHash;
  const now = new Date();
  const today = localDate(TZ, now);

  // ── Users ──
  const admin = await prisma.user.create({ data: { email: 'admin@qfree.dev', fullName: 'QFree Administrator', role: 'ADMIN', passwordHash: adminHash } });
  const clinicAdmin = await prisma.user.create({ data: { email: 'clinic@qfree.dev', fullName: 'Rekha Sharma', phone: '+91 98200 11111', role: 'ORG_ADMIN', passwordHash } });
  const labAdmin = await prisma.user.create({ data: { email: 'lab@qfree.dev', fullName: 'Suresh Kulkarni', phone: '+91 98200 22222', role: 'ORG_ADMIN', passwordHash } });
  const receptionist = await prisma.user.create({ data: { email: 'reception@qfree.dev', fullName: 'Anita Desai', role: 'ORG_ADMIN', passwordHash } });

  const demoPatient = await prisma.user.create({
    data: {
      email: 'patient@qfree.dev', fullName: 'Amit Kumar', phone: '+91 99000 12345', role: 'PATIENT', passwordHash,
      patient: { create: { dateOfBirth: new Date('1988-04-12'), gender: 'MALE' } },
    },
    include: { patient: true },
  });
  const patients: (typeof demoPatient)[] = [];
  for (let i = 0; i < 40; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    patients.push(
      await prisma.user.create({
        data: {
          email: `patient${i + 1}@qfree.dev`, fullName: name, role: 'PATIENT', passwordHash,
          phone: `+91 9${String(800000000 + i * 7919).padStart(9, '0')}`,
          patient: { create: { dateOfBirth: new Date(1950 + Math.floor(rand() * 55), Math.floor(rand() * 12), 1 + Math.floor(rand() * 27)), gender: pick(['FEMALE', 'MALE']) } },
        },
        include: { patient: true },
      }),
    );
  }

  // ── Organizations ──
  const week = (open: string, close: string, closedDays: number[] = []) =>
    [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: open, closeTime: close, isClosed: closedDays.includes(d) }));

  const mkOrg = (name: string, type: OrganizationType, extra: Partial<Prisma.OrganizationCreateInput>, hours: ReturnType<typeof week>, owner: string) =>
    prisma.organization.create({
      data: { name, type, timezone: TZ, isVerified: true, address: '', city: 'Mumbai', ...extra, hours: { create: hours }, staff: { create: { userId: owner, staffRole: 'OWNER' } } } as Prisma.OrganizationCreateInput,
    });

  const clinic = await mkOrg(
    'Sharma Family Clinic', 'CLINIC',
    { address: '12 Hill Road, Bandra West', city: 'Mumbai', phone: '+91 22 2640 1234', email: 'hello@sharmaclinic.in', description: 'Neighbourhood family practice offering general medicine and paediatrics.' },
    week('08:00', '22:00', [0]), clinicAdmin.id,
  );
  await prisma.staffMember.create({ data: { organizationId: clinic.id, userId: receptionist.id, staffRole: 'RECEPTIONIST' } });
  const hospital = await mkOrg(
    'City Care Hospital', 'HOSPITAL',
    { address: '45 Linking Road, Santacruz', city: 'Mumbai', phone: '+91 22 2660 5000', description: 'Multi-speciality hospital with 24×7 outpatient departments.' },
    week('00:00', '23:59'), clinicAdmin.id,
  );
  const lab = await mkOrg(
    'PathCare Diagnostics', 'LABORATORY',
    { address: '7 MG Road, Fort', city: 'Mumbai', phone: '+91 22 2204 7788', description: 'NABL-accredited pathology lab and imaging centre.' },
    week('06:30', '22:30'), labAdmin.id,
  );
  const puneLab = await mkOrg(
    'Wellness Lab Pune', 'LABORATORY',
    { address: '3 FC Road, Shivajinagar', city: 'Pune', description: 'Blood tests and health check-up packages.' },
    week('07:00', '20:00'), labAdmin.id,
  );

  // ── Doctors ──
  const mkDoctor = (email: string, fullName: string, orgId: string, specialization: string, qualification: string, experienceYears: number, consultationMinutes: number, bio: string) =>
    prisma.user.create({
      data: {
        email, fullName, role: 'DOCTOR', passwordHash,
        doctor: {
          create: {
            organizationId: orgId, specialization, qualification, experienceYears, consultationMinutes, bio,
            schedules: { create: [1, 2, 3, 4, 5, 6].flatMap((d) => [{ dayOfWeek: d, startTime: '09:00', endTime: '13:00' }, { dayOfWeek: d, startTime: '17:00', endTime: '21:00' }]) },
          },
        },
      },
      include: { doctor: true },
    });

  const sharma = await mkDoctor('dr.sharma@qfree.dev', 'Dr. Rajesh Sharma', clinic.id, 'General Physician', 'MBBS, MD (Medicine)', 18, 6, 'Family physician focused on preventive care, diabetes and hypertension.');
  const iyer = await mkDoctor('dr.iyer@qfree.dev', 'Dr. Lakshmi Iyer', clinic.id, 'Pediatrician', 'MBBS, DCH', 12, 10, 'Child health, vaccinations and growth monitoring.');
  const khan = await mkDoctor('dr.khan@qfree.dev', 'Dr. Imran Khan', hospital.id, 'Cardiologist', 'MBBS, MD, DM (Cardiology)', 20, 12, 'Interventional cardiologist.');
  const mehta = await mkDoctor('dr.mehta@qfree.dev', 'Dr. Nisha Mehta', hospital.id, 'Dermatologist', 'MBBS, MD (Dermatology)', 9, 8, 'Skin, hair and allergy clinic.');
  await mkDoctor('dr.rao@qfree.dev', 'Dr. Venkat Rao', hospital.id, 'Orthopedic Surgeon', 'MBBS, MS (Ortho)', 15, 12, 'Joint pain, sports injuries and fractures.');

  // ── Services ──
  const svc = (organizationId: string, name: string, category: 'CONSULTATION' | 'LAB_TEST' | 'DIAGNOSTIC', durationMinutes: number, price: number, description?: string) =>
    prisma.service.create({ data: { organizationId, name, category, durationMinutes, price, description } });

  await svc(clinic.id, 'General Consultation', 'CONSULTATION', 8, 500);
  await svc(clinic.id, 'Child Vaccination', 'CONSULTATION', 10, 300);
  const bloodCollection = await svc(lab.id, 'Blood Sample Collection', 'LAB_TEST', 4, 0, 'CBC, lipid profile, thyroid, blood sugar and more. Fasting samples before 10 AM.');
  const xray = await svc(lab.id, 'Digital X-Ray', 'DIAGNOSTIC', 7, 650);
  await svc(lab.id, 'Ultrasound', 'DIAGNOSTIC', 15, 1500);
  await svc(lab.id, 'ECG', 'DIAGNOSTIC', 10, 350);
  const puneBlood = await svc(puneLab.id, 'Full Body Check-up', 'LAB_TEST', 6, 2499);
  await svc(hospital.id, 'Cardiology OPD', 'CONSULTATION', 12, 1000);

  // ── Queues ──
  const mkQueue = (organizationId: string, name: string, tokenPrefix: string, avgMinutes: number, extra: Partial<Prisma.QueueUncheckedCreateInput> = {}) =>
    prisma.queue.create({ data: { organizationId, name, tokenPrefix, avgServiceSeconds: avgMinutes * 60, capacity: 120, ...extra } });

  const qSharma = await mkQueue(clinic.id, 'General OPD — Dr. Sharma', 'QF', 6, { doctorId: sharma.doctor!.id });
  const qIyer = await mkQueue(clinic.id, 'Paediatrics — Dr. Iyer', 'PD', 10, { doctorId: iyer.doctor!.id });
  const qKhan = await mkQueue(hospital.id, 'Cardiology OPD — Dr. Khan', 'CD', 12, { doctorId: khan.doctor!.id });
  const qMehta = await mkQueue(hospital.id, 'Dermatology — Dr. Mehta', 'DM', 8, { doctorId: mehta.doctor!.id });
  const qBlood = await mkQueue(lab.id, 'Blood Collection Counter', 'BL', 4, { serviceId: bloodCollection.id, capacity: 300 });
  const qXray = await mkQueue(lab.id, 'X-Ray Room', 'XR', 7, { serviceId: xray.id });
  const qPune = await mkQueue(puneLab.id, 'Check-up Desk', 'WL', 6, { serviceId: puneBlood.id });

  // ── 30 days of history (simulated single-server queue) ──
  const history: Prisma.QueueEntryCreateManyInput[] = [];
  const queueSpecs = [
    { q: qSharma, avg: 6, perDay: [22, 38], closedSun: true },
    { q: qIyer, avg: 10, perDay: [12, 22], closedSun: true },
    { q: qKhan, avg: 12, perDay: [10, 18], closedSun: false },
    { q: qMehta, avg: 8, perDay: [12, 24], closedSun: false },
    { q: qBlood, avg: 4, perDay: [40, 75], closedSun: false },
    { q: qXray, avg: 7, perDay: [10, 20], closedSun: false },
    { q: qPune, avg: 6, perDay: [8, 16], closedSun: false },
  ];
  for (let d = 30; d >= 1; d--) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const sessionDate = localDate(TZ, day);
    const dow = new Date(`${sessionDate}T12:00:00+05:30`).getUTCDay();
    for (const spec of queueSpecs) {
      if (spec.closedSun && dow === 0) continue;
      const count = Math.round(between(spec.perDay[0], spec.perDay[1]) * (dow === 1 ? 1.25 : dow === 6 ? 0.8 : 1));
      // Arrivals cluster in a morning peak (~10:00) and an evening peak (~18:30), local time.
      const arrivals = Array.from({ length: count }, () => {
        const morning = rand() < 0.62;
        const hour = morning ? normal(10.2, 1.0) : normal(18.4, 0.9);
        const h = Math.min(Math.max(hour, 8), 21.5);
        return new Date(Date.parse(`${sessionDate}T00:00:00+05:30`) + h * 3_600_000);
      }).sort((a, b) => a.getTime() - b.getTime());

      let free = 0;
      arrivals.forEach((joinedAt, i) => {
        const tokenNumber = i + 1;
        const r = rand();
        const status: EntryStatus = r < 0.07 ? 'CANCELLED' : r < 0.11 ? 'NO_SHOW' : 'COMPLETED';
        const base = { queueId: spec.q.id, patientId: pick(patients).patient!.id, sessionDate, tokenNumber, tokenLabel: formatToken(spec.q.tokenPrefix, tokenNumber), sortKey: sortKeyForToken(tokenNumber), joinedAt, approachingNotified: true };
        if (status === 'CANCELLED') {
          history.push({ ...base, status, cancelledAt: new Date(joinedAt.getTime() + between(5, 40) * MIN), note: 'Left by patient' });
          return;
        }
        const calledAt = new Date(Math.max(joinedAt.getTime() + between(1, 4) * MIN, free));
        if (status === 'NO_SHOW') {
          history.push({ ...base, status, calledAt, skipCount: 1 });
          free = calledAt.getTime() + 1 * MIN;
          return;
        }
        const service = Math.max(1.5, normal(spec.avg, spec.avg * 0.35)) * MIN;
        const completedAt = new Date(calledAt.getTime() + service);
        free = completedAt.getTime() + between(0.3, 1.5) * MIN;
        history.push({ ...base, status, calledAt, completedAt, priority: rand() < 0.03 ? 'PRIORITY' : 'NORMAL' });
      });
    }
  }
  for (let i = 0; i < history.length; i += 1000) await prisma.queueEntry.createMany({ data: history.slice(i, i + 1000) });

  // ── Today: live sessions ──
  type LiveSpec = { q: typeof qSharma; served: number; waiting: number; avg: number; status?: 'OPEN' | 'PAUSED' };
  const live: LiveSpec[] = [
    { q: qSharma, served: 23, waiting: 6, avg: 6 },
    { q: qIyer, served: 9, waiting: 4, avg: 10 },
    { q: qKhan, served: 5, waiting: 3, avg: 12, status: 'PAUSED' },
    { q: qBlood, served: 41, waiting: 8, avg: 4 },
    { q: qXray, served: 7, waiting: 2, avg: 7 },
  ];
  for (const spec of live) {
    const pool = [...patients].sort(() => rand() - 0.5);
    const total = spec.served + 1 + spec.waiting;
    const entries: Prisma.QueueEntryCreateManyInput[] = [];
    for (let t = 1; t <= total; t++) {
      const patientId = pool[(t - 1) % pool.length].patient!.id;
      const base = { queueId: spec.q.id, patientId, sessionDate: today, tokenNumber: t, tokenLabel: formatToken(spec.q.tokenPrefix, t), sortKey: sortKeyForToken(t) };
      if (t <= spec.served) {
        const calledAt = new Date(now.getTime() - ((spec.served + 1 - t) * spec.avg + 4) * MIN);
        entries.push({ ...base, status: 'COMPLETED', joinedAt: new Date(calledAt.getTime() - between(12, 40) * MIN), calledAt, completedAt: new Date(calledAt.getTime() + spec.avg * between(0.8, 1.15) * MIN), approachingNotified: true });
      } else if (t === spec.served + 1) {
        entries.push({ ...base, status: 'SERVING', joinedAt: new Date(now.getTime() - 38 * MIN), calledAt: new Date(now.getTime() - 3 * MIN), approachingNotified: true });
      } else {
        const k = t - spec.served - 1;
        entries.push({ ...base, status: 'WAITING', joinedAt: new Date(now.getTime() - (spec.waiting - k + 1) * 5 * MIN), approachingNotified: k <= 4 });
      }
    }
    await prisma.queueEntry.createMany({ data: entries });
    await prisma.queue.update({
      where: { id: spec.q.id },
      data: {
        status: spec.status ?? 'OPEN', sessionDate: today, lastTokenNumber: total, openedAt: new Date(now.getTime() - 4 * 3_600_000),
        pausedAt: spec.status === 'PAUSED' ? new Date(now.getTime() - 10 * MIN) : null,
      },
    });
    await prisma.queueEvent.create({ data: { queueId: spec.q.id, type: 'OPENED', actorId: null, createdAt: new Date(now.getTime() - 4 * 3_600_000) } });
  }

  // Full event trail for today's entries (JOINED → CALLED → COMPLETED).
  const todays = await prisma.queueEntry.findMany({ where: { sessionDate: today } });
  const events: Prisma.QueueEventCreateManyInput[] = [];
  for (const e of todays) {
    events.push({ queueId: e.queueId, entryId: e.id, actorId: null, type: 'JOINED', createdAt: e.joinedAt });
    if (e.calledAt) events.push({ queueId: e.queueId, entryId: e.id, actorId: sharma.id, type: 'CALLED', createdAt: e.calledAt });
    if (e.completedAt) events.push({ queueId: e.queueId, entryId: e.id, actorId: sharma.id, type: 'COMPLETED', createdAt: e.completedAt });
  }
  await prisma.queueEvent.createMany({ data: events });

  // ── Demo patient: past visits + notifications ──
  const pastSharma = await prisma.queueEntry.findMany({ where: { queueId: { in: [qSharma.id, qBlood.id, qMehta.id] }, status: { in: ['COMPLETED', 'CANCELLED'] }, sessionDate: { lt: today } }, orderBy: { joinedAt: 'desc' }, take: 6 });
  for (const e of pastSharma) await prisma.queueEntry.update({ where: { id: e.id }, data: { patientId: demoPatient.patient!.id } });

  await prisma.notification.createMany({
    data: [
      { userId: demoPatient.id, type: 'SYSTEM', title: 'Welcome to QFree', body: 'Find a doctor or lab, join the queue from your phone, and arrive just in time.', createdAt: new Date(now.getTime() - 3 * 86_400_000) },
      { userId: demoPatient.id, type: 'YOUR_TURN', title: "It's your turn — BL-012", body: 'Please proceed to Blood Collection Counter at PathCare Diagnostics now.', readAt: new Date(), createdAt: new Date(now.getTime() - 2 * 86_400_000) },
    ],
  });

  await prisma.issue.createMany({
    data: [
      { reporterId: patients[3].id, subject: 'Wrong wait estimate at X-Ray', description: 'The app said 10 minutes but I waited nearly 35 minutes at the X-Ray room.', status: 'OPEN' },
      { reporterId: sharma.id, subject: 'Need a walk-in option', description: 'Some elderly patients do not have smartphones. Can reception add them to my queue?', status: 'IN_PROGRESS', adminNote: 'Planned for the next release.' },
    ],
  });

  await prisma.auditLog.create({ data: { actorId: admin.id, action: 'system.seed', entityType: 'system', meta: { entries: history.length + todays.length } } });

  console.log(`Seeded ${history.length + todays.length} queue entries across ${queueSpecs.length} queues.`);
  console.log(`Demo password: ${PASSWORD}${adminPassword ? ' (admin uses DEMO_ADMIN_PASSWORD)' : ' for every account'}`);
  console.log('  admin@qfree.dev · clinic@qfree.dev · lab@qfree.dev · reception@qfree.dev');
  console.log('  dr.sharma@qfree.dev · dr.iyer@qfree.dev · dr.khan@qfree.dev · patient@qfree.dev');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
