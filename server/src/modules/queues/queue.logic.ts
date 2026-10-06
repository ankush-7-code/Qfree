/**
 * Pure queue algorithms (no I/O), unit-tested in tests/queue.logic.test.ts.
 *
 * Ordering:   priority band (EMERGENCY > PRIORITY > NORMAL), then sortKey asc, then token asc.
 * sortKey:    tokenNumber * 1000. Missed patients are never re-inserted; they are recalled.
 * Wait (ETA): patientsAhead * avgServiceSeconds + remaining time of the patient being served.
 * Average:    exponentially-weighted moving average of real consultation durations, with
 *             outlier clamping so a mis-click (5 s) or a forgotten "complete" (3 h) barely moves it.
 */

export type PriorityLevel = 'NORMAL' | 'PRIORITY' | 'EMERGENCY';

export const PRIORITY_RANK: Record<PriorityLevel, number> = { EMERGENCY: 2, PRIORITY: 1, NORMAL: 0 };

export const SORT_KEY_GAP = 1000;
export const MIN_AVG_SECONDS = 60;
export const MAX_AVG_SECONDS = 3600;
export const EWMA_ALPHA = 0.2;

export interface Orderable {
  priority: PriorityLevel;
  sortKey: number;
  tokenNumber: number;
}

export function compareEntries(a: Orderable, b: Orderable): number {
  return (
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.sortKey - b.sortKey || a.tokenNumber - b.tokenNumber
  );
}

export function orderWaiting<T extends Orderable>(entries: T[]): T[] {
  return [...entries].sort(compareEntries);
}

export const sortKeyForToken = (tokenNumber: number) => tokenNumber * SORT_KEY_GAP;

/**
 * The day's line is ordered by scheduled or arrival time: a booked patient by their slot start,
 * everyone else by the local time they joined. Ties fall back to token order.
 */
export const sortKeyForTime = (hhmm: string) => (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * SORT_KEY_GAP;

export const formatToken = (prefix: string, tokenNumber: number) => `${prefix}-${String(tokenNumber).padStart(3, '0')}`;

/** Remaining seconds for the patient currently being served (never below a small floor while they are inside). */
export function remainingCurrentSeconds(avgServiceSeconds: number, servingSince: Date | null, now: Date): number {
  if (!servingSince) return 0;
  const elapsed = (now.getTime() - servingSince.getTime()) / 1000;
  const floor = Math.min(60, avgServiceSeconds * 0.2);
  return Math.max(avgServiceSeconds - elapsed, floor);
}

export function estimateWaitSeconds(
  patientsAhead: number,
  avgServiceSeconds: number,
  servingSince: Date | null,
  now: Date = new Date(),
): number {
  return Math.round(patientsAhead * avgServiceSeconds + remainingCurrentSeconds(avgServiceSeconds, servingSince, now));
}

export const toMinutes = (seconds: number) => Math.max(0, Math.ceil(seconds / 60));

/** EWMA update of the average service time from one observed consultation. */
export function nextAverage(prevAvgSeconds: number, sampleSeconds: number, alpha = EWMA_ALPHA): number {
  const lower = Math.max(prevAvgSeconds / 3, MIN_AVG_SECONDS / 2);
  const upper = Math.min(prevAvgSeconds * 3, MAX_AVG_SECONDS);
  const clamped = Math.min(Math.max(sampleSeconds, lower), upper);
  const next = prevAvgSeconds * (1 - alpha) + clamped * alpha;
  return Math.round(Math.min(Math.max(next, MIN_AVG_SECONDS), MAX_AVG_SECONDS));
}

export type EntryPhase = 'YOUR_TURN' | 'NEXT' | 'APPROACHING' | 'WAITING' | 'DONE' | 'SKIPPED' | 'CANCELLED' | 'CLOSED';

export function entryPhase(
  status: string,
  patientsAhead: number,
  approachingThreshold: number,
  queueStatus: string,
): EntryPhase {
  switch (status) {
    case 'SERVING':
      return 'YOUR_TURN';
    case 'COMPLETED':
      return 'DONE';
    case 'SKIPPED':
    case 'NO_SHOW':
      return 'SKIPPED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
  if (queueStatus === 'CLOSED') return 'CLOSED';
  if (patientsAhead === 0) return 'NEXT';
  if (patientsAhead <= approachingThreshold) return 'APPROACHING';
  return 'WAITING';
}

/** Share of the line in front of the patient that has already been handled (0..1), for the progress bar. */
export function progressFraction(tokensBefore: number, patientsAhead: number): number {
  if (tokensBefore <= 0) return patientsAhead === 0 ? 1 : 0;
  return Math.min(1, Math.max(0, (tokensBefore - patientsAhead) / tokensBefore));
}

// ─────────────── Closing rules ───────────────

export type JoinBlock =
  | 'QUEUE_CLOSED' // no session today, or closed for the day
  | 'ORG_INACTIVE'
  | 'DOCTOR_UNAVAILABLE'
  | 'STOPPED_BY_DOCTOR' // manual "stop new patients"
  | 'FULL' // daily patient limit reached
  | 'CUTOFF_PASSED' // after the "stop accepting at" time
  | 'SAME_DAY_DISABLED'; // online same-day joining switched off (reception can still add patients)

export interface JoinRuleInput {
  status: 'OPEN' | 'PAUSED' | 'CLOSED';
  orgActive: boolean;
  doctorAvailable: boolean;
  joinsStopped: boolean;
  joinsReopened: boolean;
  capacity: number;
  issued: number; // tokens issued for the day, excluding cancelled
  cutoffTime: string | null; // "HH:MM" local
  localTime: string; // "HH:MM" local now
  allowSameDayJoin: boolean;
}

/**
 * Whether a patient may join today, and why not. Capacity and cutoff time are independent closing
 * rules: whichever is reached first stops new joins. A manual reopen lifts the time rule but never
 * the patient limit (the doctor raises the limit instead).
 */
export function sameDayJoinBlock(r: JoinRuleInput): JoinBlock | null {
  if (r.status === 'CLOSED') return 'QUEUE_CLOSED';
  if (!r.orgActive) return 'ORG_INACTIVE';
  if (!r.doctorAvailable) return 'DOCTOR_UNAVAILABLE';
  if (r.joinsStopped) return 'STOPPED_BY_DOCTOR';
  if (r.issued >= r.capacity) return 'FULL';
  if (r.cutoffTime && r.localTime >= r.cutoffTime && !r.joinsReopened) return 'CUTOFF_PASSED';
  if (!r.allowSameDayJoin) return 'SAME_DAY_DISABLED';
  return null;
}

export const JOIN_BLOCK_MESSAGE: Record<JoinBlock, string> = {
  QUEUE_CLOSED: 'This queue is closed right now.',
  ORG_INACTIVE: 'This provider is not accepting patients on QFree at the moment.',
  DOCTOR_UNAVAILABLE: 'The doctor is currently unavailable.',
  STOPPED_BY_DOCTOR: 'The doctor has stopped taking new patients for today.',
  FULL: 'Today’s patient limit has been reached.',
  CUTOFF_PASSED: 'New patients are no longer accepted for today.',
  SAME_DAY_DISABLED: 'Same-day online joining is not available for this queue. Please book in advance or ask at the reception.',
};

// ─────────────── Calendar helpers (dates are org-local "YYYY-MM-DD") ───────────────

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Dates a patient may book: today (later slots only) through `today + days`; none when booking is off. */
export function bookableDates(today: string, days: number): string[] {
  return days > 0 ? Array.from({ length: days + 1 }, (_, i) => addDays(today, i)) : [];
}

export interface Slot {
  start: string; // "HH:MM"
  end: string;
}

/**
 * When the provider sees patients on a weekday: the doctor's consultation slots if the doctor has
 * published any, otherwise the organization's opening hours. Closed if the organization is closed.
 */
export function dayAvailability(
  dayOfWeek: number,
  orgHours: { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }[],
  doctorSchedules: { dayOfWeek: number; startTime: string; endTime: string }[] | null,
): Slot[] {
  const org = orgHours.find((h) => h.dayOfWeek === dayOfWeek);
  if (!org || org.isClosed) return [];
  if (doctorSchedules && doctorSchedules.length) {
    return doctorSchedules
      .filter((s) => s.dayOfWeek === dayOfWeek)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .map((s) => ({ start: s.startTime, end: s.endTime }));
  }
  return [{ start: org.openTime, end: org.closeTime }];
}

export const toMinutesOfDay = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutesOfDay = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

/**
 * Estimated consultation time for the Nth patient of a day, walking through the day's slots
 * (a token that doesn't fit in the morning slot moves to the evening slot). Null if past the last slot.
 */
export function estimatedTimeForPosition(slots: Slot[], position: number, avgServiceSeconds: number): string | null {
  let offset = (position - 1) * (avgServiceSeconds / 60);
  for (const s of slots) {
    const length = toMinutesOfDay(s.end) - toMinutesOfDay(s.start);
    if (offset < length) return fromMinutesOfDay(toMinutesOfDay(s.start) + offset);
    offset -= length;
  }
  return null;
}

// ─────────────── Bookable time slots ───────────────

export const BOOKING_LEAD_MINUTES = 15; // slots later today must start at least this far ahead
export const APPOINTMENT_DUE_MINUTES = 15; // "call next" skips appointments further away than this

export interface TimeSlot {
  start: string;
  end: string;
  capacity: number;
}

/**
 * Split the day's consultation sessions into bookable slots of `slotMinutes`. Each slot holds as many
 * patients as fit at the average pace (at least one). A trailing piece shorter than half a slot is dropped.
 */
export function bookingSlots(sessions: Slot[], slotMinutes: number, avgServiceSeconds: number): TimeSlot[] {
  const out: TimeSlot[] = [];
  for (const s of sessions) {
    const end = toMinutesOfDay(s.end);
    for (let t = toMinutesOfDay(s.start); t < end; t += slotMinutes) {
      const slotEnd = Math.min(t + slotMinutes, end);
      if (slotEnd - t < slotMinutes / 2) break;
      out.push({
        start: fromMinutesOfDay(t),
        end: fromMinutesOfDay(slotEnd),
        capacity: Math.max(1, Math.floor(((slotEnd - t) * 60) / avgServiceSeconds)),
      });
    }
  }
  return out;
}

/** Whether a booked patient's slot is close enough to call them (no appointment or non-normal priority = always due). */
export function isAppointmentDue(appointmentTime: string | null, localTime: string, priority: PriorityLevel = 'NORMAL') {
  if (!appointmentTime || priority !== 'NORMAL') return true;
  return toMinutesOfDay(appointmentTime) <= toMinutesOfDay(localTime) + APPOINTMENT_DUE_MINUTES;
}

/** "17:30" → "5:30 PM" (used in notification text). */
export function twelveHour(hhmm: string) {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}
