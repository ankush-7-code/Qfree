import clsx from 'clsx';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Pause, Play, Stethoscope } from 'lucide-react';
import { api } from '../../lib/api';
import { clock, dayLabel, minutes } from '../../lib/format';
import type { QueueStatus } from '../../lib/types';
import { QueueStatusBadge } from './Status';

interface FeaturedDoctor {
  id: string;
  name: string;
  specialization: string;
  organization: { id: string; name: string; city: string };
  live: boolean;
  queue: { id: string; status: QueueStatus; currentToken: string | null; waitingCount: number; estimatedWaitMinutes: number; isAcceptingPatients: boolean };
  nextAvailable: { date: string; slots: { start: string; end: string }[] } | null;
}

const ROTATE_MS = 5_000;

/** Shuffle so each visit starts with a different doctor. */
function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <dt className="text-ink-2">{label}</dt>
      <dd className={clsx('tabular text-right font-bold', strong ? 'text-3xl text-brand' : 'text-2xl')}>{value}</dd>
    </div>
  );
}

/**
 * Home page card that rotates every 5 seconds through doctors whose queue is live right now, showing
 * their real numbers. When nobody is live, it rotates through all doctors with their next available time.
 * `fallback` is shown until data arrives (or if the server can't be reached).
 */
export function LiveShowcase({ fallback }: { fallback: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['doctors', 'featured'],
    queryFn: () => api.get<{ anyLive: boolean; items: FeaturedDoctor[] }>('/doctors/featured'),
    refetchInterval: 30_000,
  });
  // Shuffle once per list of doctors (not on every number update), so the order stays stable while rotating.
  const ids = data?.items.map((d) => d.id).join(',');
  const order = useMemo(() => shuffle(data?.items.map((d) => d.id) ?? []), [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const doctors = order.map((id) => data!.items.find((d) => d.id === id)!).filter(Boolean);

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (doctors.length < 2 || paused || hovered) return;
    const t = setInterval(() => {
      if (!document.hidden) setIndex((i) => (i + 1) % doctors.length);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [doctors.length, paused, hovered]);

  if (!doctors.length) return <>{fallback}</>;
  const d = doctors[index % doctors.length];
  const q = d.queue;

  return (
    <div
      className="w-full max-w-sm"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div className="overflow-hidden rounded-3xl border-2 border-line bg-surface shadow-xl" aria-roledescription="carousel" aria-label="Doctors on QFree right now">
        <div className="flex items-center justify-between bg-brand px-5 py-3 text-on-brand">
          <span className="font-semibold">QFree — Live Queue</span>
          {data?.anyLive ? (
            <span className="flex items-center gap-1.5 text-sm">
              <span className="live-dot size-2 rounded-full bg-current" aria-hidden /> Live
            </span>
          ) : (
            <span className="text-sm opacity-90">Upcoming</span>
          )}
        </div>

        <div key={d.id} className="fade-in p-5">
          <div className="flex items-start gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-strong">
              <Stethoscope className="size-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xl font-bold">{d.name}</p>
              <p className="text-ink-2">{d.specialization}</p>
              <p className="truncate text-sm text-muted">
                {d.organization.name}, {d.organization.city}
              </p>
            </div>
          </div>

          <dl className="mt-3">
            {d.live ? (
              <>
                <Row label="Now serving" value={q.currentToken ?? '—'} strong />
                <Row label="Patients waiting" value={q.waitingCount} />
                <Row label="Estimated wait" value={minutes(q.estimatedWaitMinutes)} />
              </>
            ) : (
              <>
                <Row label="Queue" value="Closed now" />
                <Row
                  label="Next available"
                  value={d.nextAvailable ? <span className="text-lg">{`${dayLabel(d.nextAvailable.date)}, ${clock(d.nextAvailable.slots[0].start)}`}</span> : '—'}
                />
              </>
            )}
          </dl>

          <div className="mt-4 flex items-center justify-between gap-2">
            <QueueStatusBadge snapshot={{ status: q.status }} />
            <Link to={`/doctors/${d.id}`} className="flex items-center gap-1 font-semibold text-brand hover:underline">
              {d.live && q.isAcceptingPatients ? 'Join or book' : 'Book'} <ChevronRight className="size-4" aria-hidden />
            </Link>
          </div>
        </div>
      </div>

      {doctors.length > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <div className="flex flex-wrap justify-center gap-1.5" role="tablist" aria-label="Choose a doctor">
            {doctors.map((x, i) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={i === index % doctors.length}
                aria-label={`Show ${x.name}`}
                onClick={() => setIndex(i)}
                className={clsx('h-2 rounded-full transition-all', i === index % doctors.length ? 'w-6 bg-brand' : 'w-2 bg-line hover:bg-muted')}
              />
            ))}
          </div>
          <button
            onClick={() => setPaused((p) => !p)}
            className="rounded-full p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
            aria-label={paused ? 'Resume rotating doctors' : 'Pause rotating doctors'}
          >
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
