import { describe, expect, it } from 'vitest';
import {
  entryPhase,
  estimateWaitSeconds,
  formatToken,
  nextAverage,
  orderWaiting,
  progressFraction,
  sortKeyForToken,
  sameDayJoinBlock,
  bookableDates,
  addDays,
  weekdayOf,
  dayAvailability,
  estimatedTimeForPosition,
  type JoinRuleInput,
  type Orderable,
} from '../src/modules/queues/queue.logic.js';
import { isWithinHours, localParts } from '../src/lib/time.js';

const e = (tokenNumber: number, priority: Orderable['priority'] = 'NORMAL', sortKey = sortKeyForToken(tokenNumber)) => ({ tokenNumber, priority, sortKey });

describe('ordering', () => {
  it('serves by token order within the normal band', () => {
    expect(orderWaiting([e(3), e(1), e(2)]).map((x) => x.tokenNumber)).toEqual([1, 2, 3]);
  });

  it('puts emergency before priority before normal, FIFO inside each band', () => {
    const ordered = orderWaiting([e(1), e(2, 'PRIORITY'), e(3, 'EMERGENCY'), e(4, 'PRIORITY'), e(5, 'EMERGENCY')]);
    expect(ordered.map((x) => x.tokenNumber)).toEqual([3, 5, 2, 4, 1]);
  });

  it('keeps booked tokens (numbered first) ahead of on-the-spot tokens', () => {
    expect(orderWaiting([e(9), e(2), e(5)]).map((x) => x.tokenNumber)).toEqual([2, 5, 9]);
  });
});

describe('closing rules', () => {
  const base: JoinRuleInput = {
    status: 'OPEN',
    orgActive: true,
    doctorAvailable: true,
    joinsStopped: false,
    joinsReopened: false,
    capacity: 30,
    issued: 10,
    cutoffTime: '16:00',
    localTime: '11:00',
    allowSameDayJoin: true,
  };

  it('accepts patients while under both the limit and the cutoff time', () => {
    expect(sameDayJoinBlock(base)).toBeNull();
  });

  it('closes at the patient limit or the cutoff time, whichever comes first', () => {
    expect(sameDayJoinBlock({ ...base, issued: 30 })).toBe('FULL');
    expect(sameDayJoinBlock({ ...base, localTime: '16:00' })).toBe('CUTOFF_PASSED');
    expect(sameDayJoinBlock({ ...base, issued: 30, localTime: '17:00' })).toBe('FULL');
    expect(sameDayJoinBlock({ ...base, cutoffTime: null, localTime: '23:00' })).toBeNull();
  });

  it('lets the doctor stop and reopen joins; reopening lifts the time rule but not the limit', () => {
    expect(sameDayJoinBlock({ ...base, joinsStopped: true })).toBe('STOPPED_BY_DOCTOR');
    expect(sameDayJoinBlock({ ...base, localTime: '17:00', joinsReopened: true })).toBeNull();
    expect(sameDayJoinBlock({ ...base, issued: 30, joinsReopened: true })).toBe('FULL');
  });

  it('blocks online same-day joins when the doctor only allows bookings and reception', () => {
    expect(sameDayJoinBlock({ ...base, allowSameDayJoin: false })).toBe('SAME_DAY_DISABLED');
  });

  it('reports a closed queue first', () => {
    expect(sameDayJoinBlock({ ...base, status: 'CLOSED', issued: 99 })).toBe('QUEUE_CLOSED');
  });
});

describe('booking calendar', () => {
  it('offers tomorrow through the booking window', () => {
    expect(bookableDates('2026-10-30', 3)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(bookableDates('2026-10-30', 0)).toEqual([]);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf('2026-10-06')).toBe(2); // Tuesday
  });

  const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: '08:00', closeTime: '20:00', isClosed: d === 0 }));
  const schedules = [
    { dayOfWeek: 1, startTime: '17:00', endTime: '20:00' },
    { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
  ];

  it('uses the doctor timings on clinic days, the opening hours otherwise, and nothing when closed', () => {
    expect(dayAvailability(1, hours, schedules)).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '17:00', end: '20:00' },
    ]);
    expect(dayAvailability(2, hours, schedules)).toEqual([]); // doctor not consulting on Tuesday
    expect(dayAvailability(2, hours, null)).toEqual([{ start: '08:00', end: '20:00' }]);
    expect(dayAvailability(0, hours, null)).toEqual([]); // clinic closed on Sunday
  });

  it('estimates the time of the Nth patient across the day’s slots', () => {
    const slots = [
      { start: '09:00', end: '12:00' },
      { start: '17:00', end: '20:00' },
    ];
    expect(estimatedTimeForPosition(slots, 1, 600)).toBe('09:00');
    expect(estimatedTimeForPosition(slots, 7, 600)).toBe('10:00');
    expect(estimatedTimeForPosition(slots, 19, 600)).toBe('17:00'); // morning holds 18 patients
    expect(estimatedTimeForPosition(slots, 37, 600)).toBeNull(); // beyond the evening slot
  });
});

describe('wait estimation', () => {
  const now = new Date('2026-01-01T10:00:00Z');

  it('multiplies patients ahead by the average', () => {
    expect(estimateWaitSeconds(6, 300, null, now)).toBe(1800);
  });

  it('adds the remaining time of the current consultation', () => {
    const started = new Date(now.getTime() - 120_000);
    expect(estimateWaitSeconds(2, 300, started, now)).toBe(2 * 300 + 180);
  });

  it('never assumes an overrunning consultation is already over', () => {
    const started = new Date(now.getTime() - 3_600_000);
    expect(estimateWaitSeconds(0, 300, started, now)).toBe(60);
  });
});

describe('EWMA average', () => {
  it('moves toward observed durations', () => {
    expect(nextAverage(600, 900)).toBe(660);
  });

  it('clamps outliers', () => {
    expect(nextAverage(600, 5)).toBe(520); // treated as 200 s (a third of the average)
    expect(nextAverage(600, 36_000)).toBe(840); // treated as 1800 s (3x the average)
  });

  it('stays within absolute bounds', () => {
    let avg = 600;
    for (let i = 0; i < 100; i++) avg = nextAverage(avg, 1);
    expect(avg).toBe(60);
  });
});

describe('presentation helpers', () => {
  it('formats tokens', () => {
    expect(formatToken('QF', 31)).toBe('QF-031');
    expect(formatToken('BL', 1204)).toBe('BL-1204');
  });

  it('derives the patient phase', () => {
    expect(entryPhase('SERVING', 0, 3, 'OPEN')).toBe('YOUR_TURN');
    expect(entryPhase('WAITING', 0, 3, 'OPEN')).toBe('NEXT');
    expect(entryPhase('WAITING', 3, 3, 'OPEN')).toBe('APPROACHING');
    expect(entryPhase('WAITING', 4, 3, 'OPEN')).toBe('WAITING');
    expect(entryPhase('WAITING', 4, 3, 'CLOSED')).toBe('CLOSED');
    expect(entryPhase('NO_SHOW', 0, 3, 'OPEN')).toBe('SKIPPED');
  });

  it('computes progress', () => {
    expect(progressFraction(30, 6)).toBeCloseTo(0.8);
    expect(progressFraction(0, 0)).toBe(1);
  });
});

describe('timezone helpers', () => {
  it('evaluates opening hours in the organization timezone', () => {
    const at = new Date('2026-09-26T04:30:00Z'); // Saturday 10:00 in Kolkata
    expect(localParts('Asia/Kolkata', at)).toMatchObject({ date: '2026-09-26', time: '10:00', dayOfWeek: 6 });
    const hours = [{ dayOfWeek: 6, openTime: '09:00', closeTime: '13:00', isClosed: false }];
    expect(isWithinHours(hours, 'Asia/Kolkata', at)).toBe(true);
    expect(isWithinHours(hours, 'America/New_York', at)).toBe(false);
  });
});
