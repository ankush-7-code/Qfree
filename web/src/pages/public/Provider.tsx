import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Clock, GraduationCap, Mail, MapPin, Phone } from 'lucide-react';
import { api } from '../../lib/api';
import type { DoctorSummary, Hours, OrgDetails, QueueSnapshot } from '../../lib/types';
import { categoryLabel, DAYS, initials, orgTypeLabel } from '../../lib/format';
import { useLiveSnapshots } from '../../hooks/useLive';
import { Badge, Card, CardTitle, EmptyState, ErrorState, Spinner } from '../../components/ui/primitives';
import { QueueTile } from '../../components/queue/QueueTile';
import { Link } from 'react-router';

function HoursTable({ hours }: { hours: Hours[] }) {
  const today = new Date().getDay();
  return (
    <ul className="flex flex-col divide-y divide-line">
      {DAYS.map((day, i) => {
        const h = hours.find((x) => x.dayOfWeek === i);
        return (
          <li key={day} className={`flex justify-between py-2 ${i === today ? 'font-semibold' : ''}`}>
            <span>
              {day}
              {i === today && <span className="sr-only"> (today)</span>}
            </span>
            <span className="tabular text-ink-2">{!h || h.isClosed ? 'Closed' : `${h.openTime} – ${h.closeTime}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

function LiveQueues({ queues, cacheKey }: { queues: QueueSnapshot[]; cacheKey: readonly unknown[] }) {
  useLiveSnapshots(cacheKey, queues.map((q) => q.id));
  if (!queues.length) return <EmptyState title="No queues yet">This provider has not set up a digital queue.</EmptyState>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {queues.map((q) => (
        <QueueTile key={q.id} q={q} />
      ))}
    </div>
  );
}

export function ProviderDetails() {
  const { id } = useParams();
  const key = ['organization', id] as const;
  const { data: org, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<OrgDetails>(`/organizations/${id}`) });

  if (isLoading) return <Spinner />;
  if (error || !org) return <ErrorState error={error} retry={refetch} />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <Badge tone="brand">{orgTypeLabel[org.type]}</Badge>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-bold">
          {org.name} {org.isVerified && <BadgeCheck className="size-7 text-brand" aria-label="Verified provider" />}
        </h1>
        {org.description && <p className="mt-2 max-w-3xl text-lg text-ink-2">{org.description}</p>}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-ink-2">
          <span className="flex items-center gap-1.5">
            <MapPin className="size-4" aria-hidden /> {org.address}, {org.city}
          </span>
          {org.phone && (
            <a href={`tel:${org.phone.replace(/\s/g, '')}`} className="flex items-center gap-1.5 hover:text-brand">
              <Phone className="size-4" aria-hidden /> {org.phone}
            </a>
          )}
          {org.email && (
            <a href={`mailto:${org.email}`} className="flex items-center gap-1.5 hover:text-brand">
              <Mail className="size-4" aria-hidden /> {org.email}
            </a>
          )}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardTitle>Live queues</CardTitle>
            <LiveQueues queues={org.queues} cacheKey={key} />
          </Card>
          {org.doctors.length > 0 && (
            <Card>
              <CardTitle>Doctors</CardTitle>
              <ul className="grid gap-3 sm:grid-cols-2">
                {org.doctors.map((d) => (
                  <li key={d.id}>
                    <Link to={`/doctors/${d.id}`} className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
                      <span className="grid size-11 place-items-center rounded-full bg-brand-soft font-bold text-brand-strong" aria-hidden>
                        {initials(d.name)}
                      </span>
                      <span>
                        <span className="block font-semibold">{d.name}</span>
                        <span className="text-sm text-ink-2">{d.specialization}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {org.services.length > 0 && (
            <Card>
              <CardTitle>Tests & services</CardTitle>
              <ul className="divide-y divide-line">
                {org.services.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div>
                      <p className="font-semibold">{s.name}</p>
                      <p className="text-sm text-ink-2">
                        {categoryLabel[s.category]} · about {s.durationMinutes} min{s.description ? ` · ${s.description}` : ''}
                      </p>
                    </div>
                    {s.price !== null && Number(s.price) > 0 && <span className="tabular font-semibold">₹{Number(s.price).toLocaleString()}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card className="h-fit">
          <CardTitle>
            <span className="flex items-center gap-2">
              <Clock className="size-5" aria-hidden /> Opening hours
            </span>
          </CardTitle>
          <HoursTable hours={org.hours} />
          <p className="mt-3 text-sm text-muted">Times shown in {org.timezone}.</p>
        </Card>
      </div>
    </div>
  );
}

type DoctorDetail = DoctorSummary & { schedules: { dayOfWeek: number; startTime: string; endTime: string }[]; queues: QueueSnapshot[] };

export function DoctorDetails() {
  const { id } = useParams();
  const key = ['doctor', id] as const;
  const { data: d, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<DoctorDetail>(`/doctors/${id}`) });

  if (isLoading) return <Spinner />;
  if (error || !d) return <ErrorState error={error} retry={refetch} />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center gap-5">
        <div className="grid size-20 place-items-center rounded-full bg-brand-soft text-2xl font-bold text-brand-strong" aria-hidden>
          {initials(d.name)}
        </div>
        <div>
          <h1 className="text-3xl font-bold">{d.name}</h1>
          <p className="text-lg text-ink-2">{d.specialization}</p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            {d.qualification && (
              <span className="flex items-center gap-1.5">
                <GraduationCap className="size-4" aria-hidden /> {d.qualification}
              </span>
            )}
            {d.experienceYears > 0 && <span>{d.experienceYears} years experience</span>}
            {d.organization && (
              <Link to={`/providers/${d.organization.id}`} className="flex items-center gap-1.5 text-brand hover:underline">
                <MapPin className="size-4" aria-hidden /> {d.organization.name}
              </Link>
            )}
          </div>
        </div>
      </header>
      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardTitle>Live queue</CardTitle>
            <LiveQueues queues={d.queues} cacheKey={key} />
          </Card>
          {d.bio && (
            <Card>
              <CardTitle>About</CardTitle>
              <p className="text-ink-2">{d.bio}</p>
            </Card>
          )}
        </div>
        <Card className="h-fit">
          <CardTitle>Consultation timings</CardTitle>
          {d.schedules.length === 0 ? (
            <p className="text-ink-2">Timings not published.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {DAYS.map((day, i) => {
                const slots = d.schedules.filter((s) => s.dayOfWeek === i);
                return (
                  <li key={day} className="flex justify-between gap-3 py-2">
                    <span>{day}</span>
                    <span className="tabular text-right text-ink-2">{slots.length ? slots.map((s) => `${s.startTime}–${s.endTime}`).join(', ') : 'Not available'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
