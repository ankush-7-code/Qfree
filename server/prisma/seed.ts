/**
 * Demo data. Wipes the database and recreates:
 *  - 1 admin, 2 organization admins, 12 doctors, 40 patients (password Password123; admin may use DEMO_ADMIN_PASSWORD)
 *  - Providers in Mumbai, Pune, Jammu, Srinagar and Delhi with hours, services and queues
 *  - Today's live session for Dr. Sharma: QF-001…023 served, QF-024 serving, QF-025…030 waiting
 *    → the demo patient (patient@qfree.dev) joins as QF-031 with 6 patients ahead
 *  - 30 days of simulated history (single-server queue simulation) for analytics
 *
 * With --auto on a database that already has data, only missing regional providers are added.
 */
import bcrypt from 'bcryptjs';
import type { OrganizationType, Prisma } from '../src/generated/prisma/client.js';
import { prisma } from '../src/lib/prisma.js';
import { localDate } from '../src/lib/time.js';
import { doctorSchedule, PASSWORD, pick, rand, seedLiveSession, simulateHistory, TZ, week } from './demo-lib.js';
import { addRegionalDemo, addRegionalDemoToExisting } from './demo-regions.js';
import { applyDemoUpgrades } from './demo-upgrades.js';

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
      const added = await addRegionalDemoToExisting(await bcrypt.hash(PASSWORD, 10));
      const upgrades = await applyDemoUpgrades();
      const changes = [...added.map((a) => `added ${a}`), ...upgrades];
      console.log(changes.length ? `Demo: ${changes.join('; ')}` : 'Demo seed skipped: database already has data.');
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
            schedules: { create: doctorSchedule() },
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

  // ── 30 days of history + today's live sessions ──
  const patientIds = patients.map((p) => p.patient!.id);
  const historyCount = await simulateHistory(
    [
      { q: qSharma, avg: 6, perDay: [22, 38], closedSun: true },
      { q: qIyer, avg: 10, perDay: [12, 22], closedSun: true },
      { q: qKhan, avg: 12, perDay: [10, 18], closedSun: false },
      { q: qMehta, avg: 8, perDay: [12, 24], closedSun: false },
      { q: qBlood, avg: 4, perDay: [40, 75], closedSun: false },
      { q: qXray, avg: 7, perDay: [10, 20], closedSun: false },
      { q: qPune, avg: 6, perDay: [8, 16], closedSun: false },
    ],
    patientIds,
    now,
  );
  let liveCount = 0;
  liveCount += await seedLiveSession({ q: qSharma, served: 23, waiting: 6, avg: 6 }, patientIds, now, sharma.id);
  liveCount += await seedLiveSession({ q: qIyer, served: 9, waiting: 4, avg: 10 }, patientIds, now, iyer.id);
  liveCount += await seedLiveSession({ q: qKhan, served: 5, waiting: 3, avg: 12, status: 'PAUSED' }, patientIds, now, khan.id);
  liveCount += await seedLiveSession({ q: qBlood, served: 41, waiting: 8, avg: 4 }, patientIds, now);
  liveCount += await seedLiveSession({ q: qXray, served: 7, waiting: 2, avg: 7 }, patientIds, now);

  // ── Jammu, Srinagar, Delhi ──
  const regions = await addRegionalDemo({ passwordHash, clinicOwnerId: clinicAdmin.id, labOwnerId: labAdmin.id, patientIds, now });

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

  const upgrades = await applyDemoUpgrades();
  await prisma.auditLog.create({ data: { actorId: admin.id, action: 'system.seed', entityType: 'system', meta: { entries: historyCount + liveCount, regions, upgrades } } });

  console.log(`Seeded Mumbai/Pune (${historyCount + liveCount} entries) and ${regions.length} regional providers.`);
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
