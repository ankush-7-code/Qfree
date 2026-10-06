import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, CalendarDays, Clock, GraduationCap, Mail, MapPin, Navigation, Phone, Ticket } from 'lucide-react';
import { api } from '../../lib/api';
import type { DoctorAvailability, DoctorSummary, Hours, OrgDetails, OrgType, QueueSnapshot } from '../../lib/types';
import { categoryLabel, clock, DAYS, dayLabel, initials, orgTypeLabel, slotsLabel } from '../../lib/format';
import { useLiveSnapshots } from '../../hooks/useLive';
import { Badge, Card, CardTitle, EmptyState, ErrorState, Spinner } from '../../components/ui/primitives';
import { QueueTile } from '../../components/queue/QueueTile';
import { buttonClass, LinkButton } from '../../components/ui/Button';

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

type DoctorDetail = Omit<DoctorSummary, 'organization'> & {
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  organization: { id: string; name: string; type: OrgType; city: string; address: string; phone: string | null; timezone: string } | null;
  availability: DoctorAvailability;
  queues: QueueSnapshot[];
};

/** One-line answer to "when can I see this doctor?" */
function AvailabilityChip({ d }: { d: DoctorDetail }) {
  const a = d.availability;
  if (!d.isAvailable) return <Badge tone="paused">Not available today</Badge>;
  if (a.consultingNow) return <Badge tone="active">Consulting now</Badge>;
  if (a.next?.date === a.today) return <Badge tone="approach">Today {slotsLabel(a.next.slots)}</Badge>;
  if (a.next) return <Badge tone="neutral">Next available {dayLabel(a.next.date)}, {clock(a.next.slots[0].start)}</Badge>;
  return <Badge tone="neutral">No consultation hours in the next two weeks</Badge>;
}

const mapsUrl = (o: { name: string; address: string; city: string }) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${o.name}, ${o.address}, ${o.city}`)}`;

export function DoctorDetails() {
  const { id } = useParams();
  const key = ['doctor', id] as const;
  const { data: d, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<DoctorDetail>(`/doctors/${id}`) });
  useLiveSnapshots(key, d?.queues.map((q) => q.id) ?? []);

  if (isLoading) return <Spinner />;
  if (error || !d) return <ErrorState error={error} retry={refetch} />;
  const todayDow = new Date(`${d.availability.today}T12:00:00`).getDay();

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
          </div>
          <div className="mt-2">
            <AvailabilityChip d={d} />
          </div>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardTitle>Queue & appointments</CardTitle>
            {d.queues.length === 0 ? (
              <EmptyState title="No queue yet">This doctor has not set up a digital queue.</EmptyState>
            ) : (
              <div className="flex flex-col gap-4">
                {d.queues.map((q) => (
                  <div key={q.id} className="flex flex-col gap-2">
                    <QueueTile q={q} />
                    <div className="flex flex-wrap gap-2">
                      {q.isAcceptingPatients && (
                        <LinkButton to={`/queues/${q.id}`} icon={<Ticket className="size-5" />}>
                          Join today's queue
                        </LinkButton>
                      )}
                      {q.advanceBookingDays > 0 && (
                        <LinkButton to={`/queues/${q.id}#book`} variant={q.isAcceptingPatients ? 'secondary' : 'primary'} icon={<CalendarDays className="size-5" />}>
                          Book a later day
                        </LinkButton>
                      )}
                    </div>
                    {!q.isAcceptingPatients && q.joinBlockMessage && <p className="text-sm text-ink-2">Today: {q.joinBlockMessage}</p>}
                  </div>
                ))}
              </div>
            )}
          </Card>
          {d.bio && (
            <Card>
              <CardTitle>About</CardTitle>
              <p className="text-ink-2">{d.bio}</p>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardTitle>
            <span className="flex items-center gap-2">
              <Clock className="size-5" aria-hidden /> When & where
            </span>
          </CardTitle>
          <ul className="flex flex-col divide-y divide-line" aria-label="Consultation days and timings">
            {d.availability.weekly.map(({ dayOfWeek, slots }) => (
              <li key={dayOfWeek} className={`flex justify-between gap-3 py-2 ${dayOfWeek === todayDow ? 'font-semibold' : ''}`}>
                <span>
                  {DAYS[dayOfWeek]}
                  {dayOfWeek === todayDow && <span className="ml-1 text-sm font-normal text-muted">(today)</span>}
                </span>
                <span className={`tabular flex flex-col text-right ${slots.length ? 'text-ink-2' : 'text-muted'}`}>
                  {slots.length ? slots.map((s) => <span key={s.start} className="whitespace-nowrap">{slotsLabel([s])}</span>) : 'Not available'}
                </span>
              </li>
            ))}
          </ul>
          {d.schedules.length === 0 && <p className="mt-2 text-sm text-muted">Based on the clinic's opening hours.</p>}

          {d.organization ? (
            <div className="mt-5 border-t border-line pt-4">
              <p className="flex items-start gap-2">
                <MapPin className="mt-1 size-4 shrink-0 text-brand" aria-hidden />
                <span>
                  <Link to={`/providers/${d.organization.id}`} className="font-semibold hover:text-brand hover:underline">
                    {d.organization.name}
                  </Link>
                  <span className="block text-ink-2">
                    {d.organization.address}, {d.organization.city}
                  </span>
                </span>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={mapsUrl(d.organization)} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'sm')}>
                  <Navigation className="size-4" aria-hidden /> Open in Maps
                </a>
                {d.organization.phone && (
                  <a href={`tel:${d.organization.phone.replace(/\s/g, '')}`} className={buttonClass('secondary', 'sm')}>
                    <Phone className="size-4" aria-hidden /> {d.organization.phone}
                  </a>
                )}
              </div>
              <p className="mt-3 text-sm text-muted">Times shown in {d.availability.timezone}.</p>
            </div>
          ) : (
            <p className="mt-4 text-ink-2">This doctor has not added a clinic location yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
