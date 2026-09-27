import { describe, expect, it } from 'vitest';
import {
  entryPhase,
  estimateWaitSeconds,
  formatToken,
  nextAverage,
  orderWaiting,
  progressFraction,
  renumberBand,
  requeueSortKey,
  sortKeyForToken,
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

  it('respects a re-inserted sort key', () => {
    const ordered = orderWaiting([e(10), e(11), e(12), e(4, 'NORMAL', 11_500)]);
    expect(ordered.map((x) => x.tokenNumber)).toEqual([10, 11, 4, 12]);
  });
});

describe('requeue sort key', () => {
  it('places the patient after the grace positions', () => {
    const band = [{ sortKey: 10_000 }, { sortKey: 11_000 }, { sortKey: 12_000 }];
    expect(requeueSortKey(band, 2)).toBe(11_500);
  });

  it('goes to the back when fewer than grace patients wait', () => {
    expect(requeueSortKey([{ sortKey: 5_000 }], 2)).toBe(6_000);
    expect(requeueSortKey([], 2)).toBe(0);
  });

  it('asks for a renumber when keys are adjacent, and renumbering creates room', () => {
    const band = [{ id: 'a', sortKey: 1 }, { id: 'b', sortKey: 2 }, { id: 'c', sortKey: 3 }];
    expect(requeueSortKey(band, 2)).toBeNull();
    const renum = renumberBand(band);
    expect(requeueSortKey(renum, 2)).toBe(2_500);
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
