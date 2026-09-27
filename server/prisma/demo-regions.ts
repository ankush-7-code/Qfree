/**
 * Demo providers in Jammu, Srinagar and Delhi. Idempotent: an organization that already exists
 * (matched by name) is skipped, so this can run on every deploy of a live database.
 */
import type { OrganizationType, ServiceCategory } from '../src/generated/prisma/client.js';
import { prisma } from '../src/lib/prisma.js';
import { doctorSchedule, seedLiveSession, simulateHistory, TZ, week, type HistorySpec } from './demo-lib.js';

interface DoctorDef {
  email: string;
  fullName: string;
  specialization: string;
  qualification: string;
  experienceYears: number;
  minutes: number;
  bio: string;
  queue: { name: string; prefix: string; perDay: [number, number]; live?: { served: number; waiting: number; status?: 'OPEN' | 'PAUSED' } };
}

interface ServiceDef {
  name: string;
  category: ServiceCategory;
  minutes: number;
  price: number;
  description?: string;
  queue?: { name: string; prefix: string; perDay: [number, number]; capacity?: number; live?: { served: number; waiting: number } };
}

interface OrgDef {
  name: string;
  type: OrganizationType;
  city: string;
  address: string;
  phone?: string;
  description: string;
  hours: ReturnType<typeof week>;
  owner: 'clinic' | 'lab';
  doctors?: DoctorDef[];
  services?: ServiceDef[];
}

export const REGIONAL_ORGS: OrgDef[] = [
  // ── Jammu ──
  {
    name: 'Jammu City Hospital', type: 'HOSPITAL', city: 'Jammu', address: 'Residency Road, Gandhi Nagar', phone: '+91 191 245 0011',
    description: 'Multi-speciality hospital with round-the-clock outpatient services.', hours: week('00:00', '23:59'), owner: 'clinic',
    doctors: [
      { email: 'dr.gupta@qfree.dev', fullName: 'Dr. Sunil Gupta', specialization: 'General Physician', qualification: 'MBBS, MD (Medicine)', experienceYears: 16, minutes: 7, bio: 'Fever, diabetes, blood pressure and general health.', queue: { name: 'General OPD — Dr. Gupta', prefix: 'JG', perDay: [20, 34], live: { served: 14, waiting: 5 } } },
      { email: 'dr.raina@qfree.dev', fullName: 'Dr. Meenakshi Raina', specialization: 'Gynecologist', qualification: 'MBBS, MS (Obstetrics & Gynaecology)', experienceYears: 11, minutes: 12, bio: "Women's health and antenatal care.", queue: { name: 'Gynaecology — Dr. Raina', prefix: 'JR', perDay: [10, 18], live: { served: 6, waiting: 3 } } },
    ],
  },
  {
    name: 'Trikuta Diagnostics', type: 'LABORATORY', city: 'Jammu', address: 'Trikuta Nagar', phone: '+91 191 247 3300',
    description: 'Pathology lab with home sample collection.', hours: week('07:00', '21:00'), owner: 'lab',
    services: [
      { name: 'Blood Sample Collection', category: 'LAB_TEST', minutes: 4, price: 0, description: 'CBC, thyroid, sugar, lipid profile. Fasting samples before 10 AM.', queue: { name: 'Sample Collection', prefix: 'TD', perDay: [35, 60], capacity: 250, live: { served: 22, waiting: 6 } } },
      { name: 'ECG', category: 'DIAGNOSTIC', minutes: 10, price: 300 },
    ],
  },
  // ── Srinagar ──
  {
    name: 'Dal View Clinic', type: 'CLINIC', city: 'Srinagar', address: 'Boulevard Road, Dalgate', phone: '+91 194 250 1122',
    description: 'Family clinic for adults and children near Dal Lake.', hours: week('09:00', '20:00', [0]), owner: 'clinic',
    doctors: [
      { email: 'dr.wani@qfree.dev', fullName: 'Dr. Farooq Ahmad Wani', specialization: 'General Physician', qualification: 'MBBS, MD', experienceYears: 20, minutes: 8, bio: 'Chronic illness care and general medicine.', queue: { name: 'General OPD — Dr. Wani', prefix: 'FW', perDay: [18, 30], live: { served: 11, waiting: 4 } } },
      { email: 'dr.qadri@qfree.dev', fullName: 'Dr. Nazia Qadri', specialization: 'Pediatrician', qualification: 'MBBS, MD (Paediatrics)', experienceYears: 9, minutes: 10, bio: 'Newborn care, vaccinations and child development.', queue: { name: 'Paediatrics — Dr. Qadri', prefix: 'NQ', perDay: [10, 20] } },
    ],
  },
  {
    name: 'Valley Path Labs', type: 'LABORATORY', city: 'Srinagar', address: 'Residency Road, Lal Chowk', phone: '+91 194 247 8899',
    description: 'Blood tests and digital X-ray under one roof.', hours: week('08:00', '20:00'), owner: 'lab',
    services: [
      { name: 'Blood Tests', category: 'LAB_TEST', minutes: 5, price: 0, queue: { name: 'Blood Test Counter', prefix: 'VP', perDay: [25, 45], capacity: 200, live: { served: 15, waiting: 3 } } },
      { name: 'Digital X-Ray', category: 'DIAGNOSTIC', minutes: 8, price: 500, queue: { name: 'X-Ray Room', prefix: 'VX', perDay: [8, 16] } },
    ],
  },
  // ── Delhi ──
  {
    name: 'Capital Care Hospital', type: 'HOSPITAL', city: 'Delhi', address: 'Barakhamba Road, Connaught Place', phone: '+91 11 4150 2000',
    description: 'Tertiary-care hospital with specialist outpatient departments.', hours: week('00:00', '23:59'), owner: 'clinic',
    doctors: [
      { email: 'dr.malhotra@qfree.dev', fullName: 'Dr. Arvind Malhotra', specialization: 'Cardiologist', qualification: 'MBBS, MD, DM (Cardiology)', experienceYears: 22, minutes: 12, bio: 'Heart disease, hypertension and cardiac rehabilitation.', queue: { name: 'Cardiology — Dr. Malhotra', prefix: 'CM', perDay: [12, 22], live: { served: 8, waiting: 5 } } },
      { email: 'dr.bansal@qfree.dev', fullName: 'Dr. Priya Bansal', specialization: 'Dermatologist', qualification: 'MBBS, MD (Dermatology)', experienceYears: 10, minutes: 8, bio: 'Skin, hair and allergy treatment.', queue: { name: 'Dermatology — Dr. Bansal', prefix: 'PB', perDay: [16, 28], live: { served: 12, waiting: 7 } } },
      { email: 'dr.sethi@qfree.dev', fullName: 'Dr. Rohit Sethi', specialization: 'Orthopedic Surgeon', qualification: 'MBBS, MS (Orthopaedics)', experienceYears: 14, minutes: 12, bio: 'Joint pain, fractures and sports injuries.', queue: { name: 'Orthopaedics — Dr. Sethi', prefix: 'RS', perDay: [10, 18], live: { served: 4, waiting: 2, status: 'PAUSED' } } },
    ],
  },
  {
    name: 'Lodhi Diagnostics', type: 'LABORATORY', city: 'Delhi', address: 'Lodhi Road, Pragati Vihar', phone: '+91 11 2436 5500',
    description: 'Full-service diagnostics: pathology, MRI and ultrasound.', hours: week('06:30', '22:00'), owner: 'lab',
    services: [
      { name: 'Blood Sample Collection', category: 'LAB_TEST', minutes: 4, price: 0, queue: { name: 'Sample Collection', prefix: 'LD', perDay: [50, 85], capacity: 300, live: { served: 35, waiting: 9 } } },
      { name: 'MRI Scan', category: 'DIAGNOSTIC', minutes: 30, price: 6500, description: 'Remove metal objects; arrive 15 minutes early.', queue: { name: 'MRI Suite', prefix: 'LM', perDay: [6, 12] } },
      { name: 'Ultrasound', category: 'DIAGNOSTIC', minutes: 15, price: 1400 },
    ],
  },
];

/** Adds any missing regional demo organizations. Returns the names added. */
export async function addRegionalDemo(opts: { passwordHash: string; clinicOwnerId: string; labOwnerId: string; patientIds: string[]; now?: Date }) {
  const now = opts.now ?? new Date();
  const added: string[] = [];
  for (const def of REGIONAL_ORGS) {
    if (await prisma.organization.findFirst({ where: { name: def.name }, select: { id: true } })) continue;

    const org = await prisma.organization.create({
      data: {
        name: def.name, type: def.type, city: def.city, address: def.address, phone: def.phone, description: def.description,
        timezone: TZ, isVerified: true,
        hours: { create: def.hours },
        staff: { create: { userId: def.owner === 'clinic' ? opts.clinicOwnerId : opts.labOwnerId, staffRole: 'OWNER' } },
      },
    });
    const history: HistorySpec[] = [];
    const live: { spec: Parameters<typeof seedLiveSession>[0]; actor: string | null }[] = [];

    for (const d of def.doctors ?? []) {
      if (await prisma.user.findUnique({ where: { email: d.email }, select: { id: true } })) continue;
      const user = await prisma.user.create({
        data: {
          email: d.email, fullName: d.fullName, role: 'DOCTOR', passwordHash: opts.passwordHash,
          doctor: {
            create: {
              organizationId: org.id, specialization: d.specialization, qualification: d.qualification,
              experienceYears: d.experienceYears, consultationMinutes: d.minutes, bio: d.bio, schedules: { create: doctorSchedule() },
            },
          },
        },
        include: { doctor: true },
      });
      const q = await prisma.queue.create({
        data: { organizationId: org.id, doctorId: user.doctor!.id, name: d.queue.name, tokenPrefix: d.queue.prefix, avgServiceSeconds: d.minutes * 60, capacity: 120 },
      });
      history.push({ q, avg: d.minutes, perDay: d.queue.perDay, closedSun: def.hours[0].isClosed });
      if (d.queue.live) live.push({ spec: { q, avg: d.minutes, ...d.queue.live }, actor: user.id });
    }

    for (const s of def.services ?? []) {
      const service = await prisma.service.create({
        data: { organizationId: org.id, name: s.name, category: s.category, durationMinutes: s.minutes, price: s.price, description: s.description },
      });
      if (!s.queue) continue;
      const q = await prisma.queue.create({
        data: { organizationId: org.id, serviceId: service.id, name: s.queue.name, tokenPrefix: s.queue.prefix, avgServiceSeconds: s.minutes * 60, capacity: s.queue.capacity ?? 120 },
      });
      history.push({ q, avg: s.minutes, perDay: s.queue.perDay, closedSun: def.hours[0].isClosed });
      if (s.queue.live) live.push({ spec: { q, avg: s.minutes, ...s.queue.live }, actor: null });
    }

    await simulateHistory(history, opts.patientIds, now);
    for (const l of live) await seedLiveSession(l.spec, opts.patientIds, now, l.actor);
    added.push(`${def.name} (${def.city})`);
  }
  return added;
}

/** For an already-seeded database: find the demo owners and patients, then add missing regions. */
export async function addRegionalDemoToExisting(passwordHash: string) {
  const [clinic, lab] = await Promise.all([
    prisma.user.findUnique({ where: { email: 'clinic@qfree.dev' }, select: { id: true } }),
    prisma.user.findUnique({ where: { email: 'lab@qfree.dev' }, select: { id: true } }),
  ]);
  if (!clinic || !lab) return [];
  // Only the demo patients, never real sign-ups, appear in simulated queues.
  const patients = await prisma.patient.findMany({ where: { user: { email: { startsWith: 'patient', endsWith: '@qfree.dev' }, NOT: { email: 'patient@qfree.dev' } } }, select: { id: true } });
  if (!patients.length) return [];
  return addRegionalDemo({ passwordHash, clinicOwnerId: clinic.id, labOwnerId: lab.id, patientIds: patients.map((p) => p.id) });
}
