import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BadgeCheck, Building2, FlaskConical, MapPin, Search as SearchIcon, Stethoscope, TestTubes } from 'lucide-react';
import { api } from '../../lib/api';
import type { DoctorSummary, OrgSummary, Paged, Service } from '../../lib/types';
import { categoryLabel, initials, orgTypeLabel } from '../../lib/format';
import { Badge, Card, EmptyState, ErrorState, inputClass, PageHeader, Pagination, Spinner, Tabs } from '../../components/ui/primitives';

type Kind = 'doctors' | 'clinics' | 'labs' | 'services';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function DoctorCard({ d }: { d: DoctorSummary }) {
  return (
    <Link to={`/doctors/${d.id}`} className="flex gap-4 rounded-2xl border border-line bg-surface p-4 hover:border-brand">
      <div className="grid size-14 shrink-0 place-items-center rounded-full bg-brand-soft text-lg font-bold text-brand-strong" aria-hidden>
        {initials(d.name)}
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold">{d.name}</p>
        <p className="text-ink-2">
          {d.specialization}
          {d.experienceYears ? ` · ${d.experienceYears} yrs` : ''}
        </p>
        {d.organization && (
          <p className="flex items-center gap-1 text-sm text-muted">
            <MapPin className="size-3.5" aria-hidden /> {d.organization.name}, {d.organization.city}
          </p>
        )}
        <div className="mt-2">{d.isAvailable ? <Badge tone="active">Available</Badge> : <Badge tone="paused">Not available</Badge>}</div>
      </div>
    </Link>
  );
}

function OrgCard({ o }: { o: OrgSummary }) {
  const Icon = o.type === 'LABORATORY' || o.type === 'DIAGNOSTIC_CENTER' ? FlaskConical : Building2;
  return (
    <Link to={`/providers/${o.id}`} className="flex gap-4 rounded-2xl border border-line bg-surface p-4 hover:border-brand">
      <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand-strong">
        <Icon className="size-7" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-lg font-semibold">
          {o.name} {o.isVerified && <BadgeCheck className="size-5 text-brand" aria-label="Verified" />}
        </p>
        <p className="text-ink-2">{orgTypeLabel[o.type]}</p>
        <p className="flex items-center gap-1 text-sm text-muted">
          <MapPin className="size-3.5" aria-hidden /> {o.address}, {o.city}
        </p>
        {o._count && (
          <p className="mt-1 text-sm text-ink-2">
            {o._count.doctors} doctors · {o._count.services} services · {o._count.queues} queues
          </p>
        )}
      </div>
    </Link>
  );
}

type ServiceRow = Service & { organization: { id: string; name: string; city: string }; queues: { id: string; status: string }[] };

function ServiceCard({ s }: { s: ServiceRow }) {
  const queue = s.queues[0];
  return (
    <Link to={queue ? `/queues/${queue.id}` : `/providers/${s.organization.id}`} className="flex gap-4 rounded-2xl border border-line bg-surface p-4 hover:border-brand">
      <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand-strong">
        <TestTubes className="size-7" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold">{s.name}</p>
        <p className="text-ink-2">
          {categoryLabel[s.category]} · {s.organization.name}, {s.organization.city}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {s.price !== null && Number(s.price) > 0 && <Badge>₹{Number(s.price).toLocaleString()}</Badge>}
          {queue ? <Badge tone={queue.status === 'CLOSED' ? 'closed' : 'active'}>{queue.status === 'CLOSED' ? 'Queue closed' : 'Live queue'}</Badge> : <Badge>No queue</Badge>}
        </div>
      </div>
    </Link>
  );
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('type') as Kind) || 'doctors';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [city, setCity] = useState(params.get('city') ?? '');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);

  useEffect(() => setPage(1), [kind, dq, city]);
  useEffect(() => {
    const next = new URLSearchParams();
    if (kind !== 'doctors') next.set('type', kind);
    if (dq) next.set('q', dq);
    if (city) next.set('city', city);
    setParams(next, { replace: true });
  }, [kind, dq, city, setParams]);

  const cities = useQuery({ queryKey: ['cities'], queryFn: () => api.get<string[]>('/organizations/cities'), staleTime: 300_000 });

  const endpoint = { doctors: '/doctors', clinics: '/organizations', labs: '/organizations', services: '/services' }[kind];
  const extra = kind === 'labs' ? { type: 'LABORATORY' } : kind === 'clinics' ? { type: 'CLINIC' } : {};
  const results = useQuery({
    queryKey: ['search', kind, dq, city, page],
    queryFn: () => api.get<Paged<unknown>>(endpoint, { q: dq, city, page, pageSize: 12, ...extra }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader title="Find care" subtitle="Search doctors, clinics, laboratories and tests — and see their live queues." />
      <Card className="mb-6 flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="relative flex-1">
            <span className="sr-only">Search</span>
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
            <input
              className={`${inputClass} pl-11 text-lg`}
              placeholder={kind === 'doctors' ? 'Doctor name or speciality' : kind === 'services' ? 'Test or service, e.g. X-Ray' : 'Name or area'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <label className="sm:w-56">
            <span className="sr-only">City</span>
            <select className={inputClass} value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">All cities</option>
              {cities.data?.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <Tabs
          value={kind}
          onChange={(v) => setParams((p) => (v === 'doctors' ? p.delete('type') : p.set('type', v), p), { replace: true })}
          options={[
            { value: 'doctors', label: <span className="flex items-center gap-2"><Stethoscope className="size-4" aria-hidden />Doctors</span> },
            { value: 'clinics', label: <span className="flex items-center gap-2"><Building2 className="size-4" aria-hidden />Clinics</span> },
            { value: 'labs', label: <span className="flex items-center gap-2"><FlaskConical className="size-4" aria-hidden />Laboratories</span> },
            { value: 'services', label: <span className="flex items-center gap-2"><TestTubes className="size-4" aria-hidden />Tests & services</span> },
          ]}
        />
      </Card>

      {results.isLoading ? (
        <Spinner />
      ) : results.error ? (
        <ErrorState error={results.error} retry={results.refetch} />
      ) : !results.data?.items.length ? (
        <EmptyState title="No results">Try a different name, speciality or city.</EmptyState>
      ) : (
        <>
          <p className="mb-3 text-ink-2" aria-live="polite">
            {results.data.total} result{results.data.total === 1 ? '' : 's'}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {results.data.items.map((item) =>
              kind === 'doctors' ? (
                <DoctorCard key={(item as DoctorSummary).id} d={item as DoctorSummary} />
              ) : kind === 'services' ? (
                <ServiceCard key={(item as ServiceRow).id} s={item as ServiceRow} />
              ) : (
                <OrgCard key={(item as OrgSummary).id} o={item as OrgSummary} />
              ),
            )}
          </div>
          <Pagination page={page} totalPages={results.data.totalPages} onPage={setPage} />
        </>
      )}
    </div>
  );
}
