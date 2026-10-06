import type { EntrySource, EntryStatus, OrgType, Priority, ServiceCategory, StaffRole } from './types';

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const orgTypeLabel: Record<OrgType, string> = {
  CLINIC: 'Clinic',
  LABORATORY: 'Laboratory',
  HOSPITAL: 'Hospital',
  DIAGNOSTIC_CENTER: 'Diagnostic centre',
};

export const categoryLabel: Record<ServiceCategory, string> = {
  CONSULTATION: 'Consultation',
  LAB_TEST: 'Lab test',
  DIAGNOSTIC: 'Diagnostic',
  PROCEDURE: 'Procedure',
  OTHER: 'Other',
};

export const entryStatusLabel: Record<EntryStatus, string> = {
  BOOKED: 'Booked',
  WAITING: 'Waiting',
  SERVING: 'Called',
  COMPLETED: 'Completed',
  SKIPPED: 'Missed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

/** "Recalled" is a called patient who had missed their turn earlier. */
export const statusLabelFor = (e: { status: EntryStatus; recalledAt?: string | null }) =>
  e.status === 'SERVING' && e.recalledAt ? 'Recalled' : entryStatusLabel[e.status];

export const sourceLabel: Record<EntrySource, string> = {
  SAME_DAY: 'Joined today',
  ADVANCE: 'Booked',
  RECEPTION: 'At reception',
};

/** "2026-10-07" → "Wed, 7 Oct" (calendar date, no timezone shift). */
export const dayLabel = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

/** "17:30" → "5:30 PM" */
export function clock(hhmm: string | null | undefined) {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const slotsLabel = (slots: { start: string; end: string }[]) =>
  slots.length ? slots.map((s) => `${clock(s.start)} – ${clock(s.end)}`).join(', ') : 'Not available';

export const priorityLabel: Record<Priority, string> = { NORMAL: 'Normal', PRIORITY: 'Priority', EMERGENCY: 'Emergency' };
export const staffRoleLabel: Record<StaffRole, string> = { OWNER: 'Owner', MANAGER: 'Manager', RECEPTIONIST: 'Receptionist' };

export function minutes(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  if (n < 1) return '< 1 min';
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';

export const date = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

export function relative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)} h ago`;
  return date(iso);
}

export const hourLabel = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

/** "10–11 AM", "11 AM–12 PM" */
export function hourRange(h: number) {
  const a = hourLabel(h);
  const b = hourLabel((h + 1) % 24);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** Local calendar date as YYYY-MM-DD (not UTC, which is off by a day around midnight). */
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const initials = (name: string) =>
  name
    .replace(/^Dr\.?\s*/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
