/** Timezone helpers. Queue sessions and opening hours are evaluated in the organization's local time. */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(timeZone: string, at: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    dayOfWeek: WEEKDAYS.indexOf(get('weekday')),
  };
}

export const localDate = (timeZone: string, at?: Date) => localParts(timeZone, at).date;

export interface HoursRow {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

/** True if `at` falls inside the opening hours for that local weekday. A missing row means closed. */
export function isWithinHours(hours: HoursRow[], timeZone: string, at: Date = new Date()): boolean {
  const { dayOfWeek, time } = localParts(timeZone, at);
  const today = hours.find((h) => h.dayOfWeek === dayOfWeek);
  if (!today || today.isClosed) return false;
  return time >= today.openTime && time < today.closeTime;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
