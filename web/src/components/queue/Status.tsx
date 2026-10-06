import clsx from 'clsx';
import { CheckCircle2, CircleSlash, Clock, Hourglass, PauseCircle, PlayCircle, Radio, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EntryStatus, Phase, QueueSnapshot, QueueStatus } from '../../lib/types';
import { statusLabelFor } from '../../lib/format';

type Tone = 'active' | 'waiting' | 'approach' | 'closed' | 'paused' | 'neutral';

const toneClass: Record<Tone, { pill: string; dot: string }> = {
  active: { pill: 'bg-st-active-soft text-st-active', dot: 'bg-st-active' },
  waiting: { pill: 'bg-st-waiting-soft text-st-waiting', dot: 'bg-st-waiting' },
  approach: { pill: 'bg-st-approach-soft text-st-approach', dot: 'bg-st-approach' },
  closed: { pill: 'bg-st-closed-soft text-st-closed', dot: 'bg-st-closed' },
  paused: { pill: 'bg-st-paused-soft text-st-paused', dot: 'bg-st-paused' },
  neutral: { pill: 'bg-surface-2 text-ink-2', dot: 'bg-muted' },
};

/** Colour is never the only signal: every indicator is a dot + icon + words. */
export function Indicator({ tone, icon, children, size = 'md', live }: { tone: Tone; icon: ReactNode; children: ReactNode; size?: 'md' | 'lg'; live?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 rounded-full font-semibold', toneClass[tone].pill, size === 'lg' ? 'px-4 py-2 text-lg' : 'px-3 py-1 text-sm')}>
      <span className={clsx('size-2.5 rounded-full', toneClass[tone].dot, live && 'live-dot')} aria-hidden />
      <span aria-hidden className="[&>svg]:size-4">{icon}</span>
      {children}
    </span>
  );
}

export function queueStatusInfo(snapshot: Pick<QueueSnapshot, 'status'> & Partial<Pick<QueueSnapshot, 'doctor'>>) {
  if (snapshot.status === 'OPEN' && snapshot.doctor && !snapshot.doctor.isAvailable) {
    return { tone: 'paused' as const, icon: <PauseCircle />, label: 'Doctor unavailable' };
  }
  const map: Record<QueueStatus, { tone: Tone; icon: ReactNode; label: string }> = {
    OPEN: { tone: 'active', icon: <PlayCircle />, label: 'Queue Active' },
    PAUSED: { tone: 'paused', icon: <PauseCircle />, label: 'Queue Paused' },
    CLOSED: { tone: 'closed', icon: <XCircle />, label: 'Queue Closed' },
  };
  return map[snapshot.status];
}

export function QueueStatusBadge({ snapshot, size }: { snapshot: Pick<QueueSnapshot, 'status'> & Partial<Pick<QueueSnapshot, 'doctor'>>; size?: 'md' | 'lg' }) {
  const s = queueStatusInfo(snapshot);
  return (
    <Indicator tone={s.tone} icon={s.icon} size={size} live={snapshot.status === 'OPEN'}>
      {s.label}
    </Indicator>
  );
}

export const phaseInfo: Record<Phase, { tone: Tone; icon: ReactNode; label: string }> = {
  YOUR_TURN: { tone: 'active', icon: <Radio />, label: "It's your turn" },
  NEXT: { tone: 'approach', icon: <Hourglass />, label: "You're next" },
  APPROACHING: { tone: 'approach', icon: <Hourglass />, label: 'Your turn is approaching' },
  WAITING: { tone: 'waiting', icon: <Clock />, label: 'Waiting' },
  DONE: { tone: 'neutral', icon: <CheckCircle2 />, label: 'Visit completed' },
  SKIPPED: { tone: 'closed', icon: <CircleSlash />, label: 'Missed your turn' },
  CANCELLED: { tone: 'neutral', icon: <XCircle />, label: 'Left the queue' },
  CLOSED: { tone: 'closed', icon: <XCircle />, label: 'Queue closed' },
};

export function PhaseBadge({ phase, size }: { phase: Phase; size?: 'md' | 'lg' }) {
  const p = phaseInfo[phase];
  return (
    <Indicator tone={p.tone} icon={p.icon} size={size} live={phase === 'YOUR_TURN'}>
      {p.label}
    </Indicator>
  );
}

const entryTone: Record<EntryStatus, Tone> = {
  BOOKED: 'approach',
  WAITING: 'waiting',
  SERVING: 'active',
  COMPLETED: 'neutral',
  SKIPPED: 'paused',
  CANCELLED: 'neutral',
  NO_SHOW: 'closed',
};

/** Booked · Waiting · Called · Missed · Recalled · Completed · Cancelled · No-show */
export function EntryStatusBadge({ status, recalledAt }: { status: EntryStatus; recalledAt?: string | null }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium', toneClass[entryTone[status]].pill)}>
      <span className={clsx('size-2 rounded-full', toneClass[entryTone[status]].dot)} aria-hidden />
      {statusLabelFor({ status, recalledAt })}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-4 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div className="h-full rounded-full bg-brand transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
