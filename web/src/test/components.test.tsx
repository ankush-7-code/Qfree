import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, errorMessage, qs } from '../lib/api';
import { clock, hourRange, minutes, statusLabelFor, time } from '../lib/format';
import type { EntryView, QueueSnapshot } from '../lib/types';

vi.mock('../hooks/useLive', () => ({ useSocketConnected: () => true }));
const { LiveQueueCard } = await import('../components/queue/LiveQueueCard');

const snapshot: QueueSnapshot = {
  id: 'q1',
  name: 'General OPD',
  tokenPrefix: 'QF',
  status: 'OPEN',
  organization: { id: 'o1', name: 'Sharma Family Clinic', type: 'CLINIC', city: 'Mumbai', address: '12 Hill Road' },
  doctor: { id: 'd1', name: 'Dr. Sharma', specialization: 'General Physician', isAvailable: true },
  service: null,
  sessionDate: '2026-09-27',
  currentToken: 'QF-024',
  servingSince: null,
  lastCalledToken: 'QF-024',
  lastIssuedToken: 'QF-031',
  waitingCount: 7,
  servedCount: 23,
  capacity: 100,
  remainingCapacity: 69,
  avgServiceMinutes: 6,
  estimatedWaitMinutes: 42,
  approachingThreshold: 3,
  isAcceptingPatients: true,
  joinBlock: null,
  joinBlockMessage: null,
  missedCount: 0,
  closingRules: { capacity: 100, cutoffTime: null, joinsStopped: false, joinsReopened: false },
  allowSameDayJoin: true,
  advanceBookingDays: 3,
  advanceBookingQuota: null,
  bookingSlotMinutes: 30,
  pausedAt: null,
  updatedAt: new Date().toISOString(),
};

const entry = (over: Partial<EntryView> = {}): EntryView => ({
  queueId: 'q1',
  entry: { id: 'e1', tokenLabel: 'QF-031', tokenNumber: 31, status: 'WAITING', priority: 'NORMAL', joinedAt: new Date().toISOString(), calledAt: null, recalledAt: null, appointmentTime: null, completedAt: null, cancelledAt: null, source: 'SAME_DAY' },
  currentToken: 'QF-024',
  patientsAhead: 6,
  estimatedWaitMinutes: 35,
  expectedAt: new Date().toISOString(),
  phase: 'WAITING',
  progress: 0.7,
  queueStatus: 'OPEN',
  ...over,
});

const renderCard = (e: EntryView) =>
  render(
    <MemoryRouter>
      <LiveQueueCard snapshot={snapshot} myEntry={e} onLeave={() => undefined} />
    </MemoryRouter>,
  );

describe('LiveQueueCard', () => {
  it('shows the essentials a patient needs at a glance', () => {
    renderCard(entry());
    expect(screen.getByText('QF-024')).toBeInTheDocument();
    expect(screen.getByText('QF-031')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('35 min')).toBeInTheDocument();
    expect(screen.getByText('Queue Active')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');
    expect(screen.getByRole('button', { name: /leave queue/i })).toBeInTheDocument();
  });

  it('announces the turn loudly and hides wait details when called', () => {
    renderCard(entry({ phase: 'YOUR_TURN', patientsAhead: 0, entry: { ...entry().entry, status: 'SERVING' } }));
    expect(screen.getByRole('alert')).toHaveTextContent("It's your turn!");
    expect(screen.queryByText('Patients ahead')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /leave queue/i })).not.toBeInTheDocument();
  });

  it('tells a recalled patient they are being called again', () => {
    const now = new Date().toISOString();
    renderCard(entry({ phase: 'YOUR_TURN', patientsAhead: 0, entry: { ...entry().entry, status: 'SERVING', calledAt: now, recalledAt: now } }));
    expect(screen.getByRole('alert')).toHaveTextContent("You're being called again!");
  });

  it('labels the approaching phase in words, not only colour', () => {
    renderCard(entry({ phase: 'APPROACHING', patientsAhead: 2 }));
    expect(screen.getByText('Your turn is approaching')).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('formats durations and hour ranges', () => {
    expect(minutes(0.4)).toBe('< 1 min');
    expect(minutes(35)).toBe('35 min');
    expect(minutes(95)).toBe('1 h 35 min');
    expect(hourRange(10)).toBe('10–11 AM');
    expect(hourRange(11)).toBe('11 AM–12 PM');
  });

  it('uses the patient-facing status names', () => {
    expect(statusLabelFor({ status: 'BOOKED' })).toBe('Booked');
    expect(statusLabelFor({ status: 'SERVING' })).toBe('Called');
    expect(statusLabelFor({ status: 'SERVING', recalledAt: '2026-10-06T10:00:00Z' })).toBe('Recalled');
    expect(statusLabelFor({ status: 'SKIPPED' })).toBe('Missed');
    // Always 12-hour with AM/PM, whatever the phone language or 24-hour setting.
    expect(clock('17:30')).toBe('5:30 PM');
    expect(clock('09:05')).toBe('9:05 AM');
    expect(clock('00:30')).toBe('12:30 AM');
    expect(clock('12:00')).toBe('12:00 PM');
    expect(time('2026-10-06T13:45:00')).toBe('1:45 PM');
  });

  it('builds query strings without empty values', () => {
    expect(qs({ q: 'x ray', page: 2, city: '', type: undefined })).toBe('?q=x+ray&page=2');
    expect(qs({})).toBe('');
  });

  it('surfaces the first field-level validation error', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request data', { fieldErrors: { password: ['Password must contain a number'] } });
    expect(errorMessage(err)).toBe('password: Password must contain a number');
    expect(errorMessage(new ApiError(409, 'QUEUE_FULL', 'This queue is full'))).toBe('This queue is full');
  });
});
