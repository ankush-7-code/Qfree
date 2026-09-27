export type Role = 'PATIENT' | 'DOCTOR' | 'ORG_ADMIN' | 'ADMIN';
export type OrgType = 'CLINIC' | 'LABORATORY' | 'HOSPITAL' | 'DIAGNOSTIC_CENTER';
export type QueueStatus = 'OPEN' | 'PAUSED' | 'CLOSED';
export type EntryStatus = 'WAITING' | 'SERVING' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED' | 'NO_SHOW';
export type Priority = 'NORMAL' | 'PRIORITY' | 'EMERGENCY';
export type Phase = 'YOUR_TURN' | 'NEXT' | 'APPROACHING' | 'WAITING' | 'DONE' | 'SKIPPED' | 'CANCELLED' | 'CLOSED';
export type StaffRole = 'OWNER' | 'MANAGER' | 'RECEPTIONIST';
export type ServiceCategory = 'CONSULTATION' | 'LAB_TEST' | 'DIAGNOSTIC' | 'PROCEDURE' | 'OTHER';

export interface Me {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: Role;
  createdAt: string;
  patient: { id: string; dateOfBirth: string | null; gender: string | null } | null;
  doctor: { id: string; organizationId: string | null; specialization: string } | null;
  organizations: { id: string; name: string; type: OrgType; staffRole: StaffRole }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface QueueSnapshot {
  id: string;
  name: string;
  tokenPrefix: string;
  status: QueueStatus;
  organization: { id: string; name: string; type: OrgType; city: string; address: string };
  doctor: { id: string; name: string; specialization: string; isAvailable: boolean } | null;
  service: { id: string; name: string; category: ServiceCategory } | null;
  sessionDate: string | null;
  currentToken: string | null;
  servingSince: string | null;
  lastCalledToken: string | null;
  lastIssuedToken: string | null;
  waitingCount: number;
  servedCount: number;
  capacity: number;
  remainingCapacity: number;
  avgServiceMinutes: number;
  estimatedWaitMinutes: number;
  approachingThreshold: number;
  isAcceptingPatients: boolean;
  pausedAt: string | null;
  updatedAt: string;
}

export interface EntryView {
  queueId: string;
  entry: {
    id: string;
    tokenLabel: string;
    tokenNumber: number;
    status: EntryStatus;
    priority: Priority;
    joinedAt: string;
    calledAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
  };
  currentToken: string | null;
  patientsAhead: number;
  estimatedWaitMinutes: number;
  expectedAt: string | null;
  phase: Phase;
  progress: number;
  queueStatus: QueueStatus;
}

export interface StaffEntry {
  id: string;
  tokenLabel: string;
  tokenNumber: number;
  status: EntryStatus;
  priority: Priority;
  skipCount: number;
  joinedAt: string;
  calledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  note: string | null;
  patient: { name: string; phone: string | null; age: number | null; gender: string | null };
  position?: number;
  estimatedWaitMinutes?: number;
}

export interface StaffView {
  snapshot: QueueSnapshot;
  serving: StaffEntry | null;
  waiting: StaffEntry[];
  skipped: StaffEntry[];
  finished: StaffEntry[];
  stats: {
    total: number;
    waiting: number;
    served: number;
    skipped: number;
    cancelled: number;
    noShow: number;
    avgWaitMinutes: number | null;
    avgConsultMinutes: number | null;
  };
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: { queueId?: string; entryId?: string } | null;
  readAt: string | null;
  createdAt: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  type: OrgType;
  description: string | null;
  address: string;
  city: string;
  phone: string | null;
  email: string | null;
  timezone: string;
  isVerified: boolean;
  _count?: { doctors: number; services: number; queues: number };
}

export interface Hours {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

export interface Service {
  id: string;
  name: string;
  category: ServiceCategory;
  description: string | null;
  durationMinutes: number;
  price: string | number | null;
  isActive?: boolean;
}

export interface DoctorSummary {
  id: string;
  name: string;
  specialization: string;
  qualification: string | null;
  experienceYears: number;
  bio?: string | null;
  consultationMinutes?: number;
  isAvailable: boolean;
  organization?: { id: string; name: string; type: OrgType; city: string; address: string } | null;
}

export interface OrgDetails extends OrgSummary {
  hours: Hours[];
  doctors: DoctorSummary[];
  services: Service[];
  queues: QueueSnapshot[];
}

export interface Analytics {
  range: { from: string; to: string; bucket: 'day' | 'week' | 'month' };
  summary: {
    total: number;
    served: number;
    cancelled: number;
    noShow: number;
    skipped: number;
    prioritized: number;
    avgWaitMinutes: number | null;
    p90WaitMinutes: number | null;
    avgConsultMinutes: number | null;
    completionRate: number | null;
    utilizationPercent: number | null;
  };
  volume: { period: string; total: number; served: number; cancelled: number; noShow: number; avgWaitMinutes: number | null }[];
  peakHours: { hour: number; joins: number }[];
  peakHour: number | null;
  weekdays: { dow: number; total: number }[];
  perQueue: { id: string; name: string; total: number; served: number; lost: number; avgWaitMinutes: number | null; avgConsultMinutes: number | null }[];
}
