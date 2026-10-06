import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, History, MapPin, Search, Ticket } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { EntryStatus, EntryView, MyBooking, Paged } from '../../lib/types';
import { clock, date, dayLabel, minutes, time } from '../../lib/format';
import { queueKey, useQueueLive } from '../../hooks/useLive';
import { Button, LinkButton } from '../../components/ui/Button';
import { Alert, Card, CardTitle, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, Table, Td } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { LiveQueueCard } from '../../components/queue/LiveQueueCard';
import { EntryStatusBadge } from '../../components/queue/Status';
import { ChangePasswordCard } from '../shared/Shared';

interface ActiveItem extends EntryView {
  queue: { id: string; name: string };
}

function useActiveQueues() {
  return useQuery({
    queryKey: ['patient', 'queues'],
    queryFn: () => api.get<{ items: ActiveItem[] }>('/patients/me/queues'),
  });
}

/** Self-contained live card for one queue the patient is in. */
function LiveQueueWidget({ queueId, compact }: { queueId: string; compact?: boolean }) {
  const { data } = useQueueLive(queueId);
  const qc = useQueryClient();
  const toast = useToast();
  const leave = useMutation({
    mutationFn: () => api.del(`/queues/${queueId}/leave`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queueKey(queueId) });
      qc.invalidateQueries({ queryKey: ['patient'] });
      toast({ tone: 'info', title: 'You have left the queue' });
    },
    onError: (err) => toast({ tone: 'error', title: 'Could not leave', body: errorMessage(err) }),
  });
  if (!data?.myEntry) return <Spinner />;
  return <LiveQueueCard snapshot={data.snapshot} myEntry={data.myEntry} onLeave={() => leave.mutate()} leaving={leave.isPending} compact={compact} />;
}

interface HistoryItem {
  id: string;
  tokenLabel: string;
  status: EntryStatus;
  sessionDate: string;
  joinedAt: string;
  calledAt: string | null;
  completedAt: string | null;
  waitedMinutes: number | null;
  queue: { id: string; name: string; organization: { id: string; name: string }; doctor: { id: string; specialization: string; user: { fullName: string } } | null; service: { name: string } | null };
}

/** Upcoming advance bookings with token, day, estimated time and location. */
function UpcomingAppointments({ emptyHint }: { emptyHint?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['patient', 'bookings'], queryFn: () => api.get<{ items: MyBooking[] }>('/patients/me/bookings') });
  const cancel = useMutation({
    mutationFn: (b: MyBooking) => api.del(`/queues/${b.queue.id}/bookings/${b.entryId}`),
    onSuccess: () => {
      toast({ tone: 'info', title: 'Booking cancelled' });
      qc.invalidateQueries({ queryKey: ['patient', 'bookings'] });
    },
    onError: (err) => toast({ tone: 'error', title: 'Could not cancel', body: errorMessage(err) }),
  });
  if (!data || (!data.items.length && !emptyHint)) return null;
  return (
    <Card className="mt-6">
      <CardTitle>
        <span className="flex items-center gap-2">
          <CalendarCheck className="size-5 text-brand" aria-hidden /> Upcoming appointments
        </span>
      </CardTitle>
      {data.items.length === 0 ? (
        <p className="text-ink-2">No upcoming bookings. Open a doctor's page to book a later day.</p>
      ) : (
        <ul className="divide-y divide-line">
          {data.items.map((b) => (
            <li key={b.entryId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {dayLabel(b.date)} · token <span className="tabular">{b.tokenLabel}</span>
                </p>
                <p className="text-ink-2">
                  <Link to={`/queues/${b.queue.id}`} className="hover:text-brand hover:underline">
                    {b.queue.doctor?.name ?? b.queue.service?.name ?? b.queue.name}
                  </Link>{' '}
                  · estimated around <strong className="text-ink">{clock(b.estimatedTime)}</strong> (patient #{b.position})
                </p>
                <p className="flex items-center gap-1 text-sm text-muted">
                  <MapPin className="size-3.5" aria-hidden /> {b.queue.organization.name}, {b.queue.organization.address}, {b.queue.organization.city}
                </p>
              </div>
              <Button variant="secondary" size="sm" loading={cancel.isPending && cancel.variables?.entryId === b.entryId} onClick={() => cancel.mutate(b)}>
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PatientDashboard() {
  const { user } = useAuth();
  const active = useActiveQueues();
  const recent = useQuery({ queryKey: ['patient', 'history', 1], queryFn: () => api.get<Paged<HistoryItem>>('/patients/me/history', { pageSize: 4 }) });
  const first = user?.fullName.split(' ')[0];

  return (
    <div>
      <PageHeader
        title={`Hello, ${first}`}
        subtitle="Your live queues appear here and update automatically."
        actions={
          <LinkButton to="/search" icon={<Search className="size-5" />}>
            Find care
          </LinkButton>
        }
      />
      {active.isLoading ? (
        <Spinner />
      ) : active.error ? (
        <ErrorState error={active.error} retry={active.refetch} />
      ) : active.data?.items.length ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {active.data.items.map((i) => (
            <LiveQueueWidget key={i.queueId} queueId={i.queueId} compact />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Ticket className="size-12" />}
            title="You're not in any queue"
            action={
              <LinkButton to="/search" size="lg">
                Find a doctor or lab
              </LinkButton>
            }
          >
            Check live waiting times and join a queue from here — no need to wait at the clinic.
          </EmptyState>
        </Card>
      )}

      <UpcomingAppointments />

      <Card className="mt-6">
        <CardTitle
          action={
            <Link to="/patient/history" className="font-semibold text-brand hover:underline">
              View all
            </Link>
          }
        >
          Recent visits
        </CardTitle>
        {recent.data?.items.length ? (
          <ul className="divide-y divide-line">
            {recent.data.items.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="font-semibold">{h.queue.doctor?.user.fullName ?? h.queue.service?.name ?? h.queue.name}</p>
                  <p className="text-sm text-ink-2">
                    {h.queue.organization.name} · {date(h.joinedAt)} · {h.tokenLabel}
                  </p>
                </div>
                <EntryStatusBadge status={h.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2">No visits yet.</p>
        )}
      </Card>
    </div>
  );
}

export function MyQueues() {
  const active = useActiveQueues();
  return (
    <div>
      <PageHeader title="My appointments & queues" subtitle="Queues you are in today, and appointments you have booked." />
      {active.isLoading ? (
        <Spinner />
      ) : active.data?.items.length ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {active.data.items.map((i) => (
            <LiveQueueWidget key={i.queueId} queueId={i.queueId} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={<Ticket className="size-12" />} title="Not in a queue today" action={<LinkButton to="/search">Find care</LinkButton>} />
        </Card>
      )}
      <UpcomingAppointments emptyHint />
    </div>
  );
}

export function PatientHistory() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['patient', 'history', 'page', page],
    queryFn: () => api.get<Paged<HistoryItem>>('/patients/me/history', { page, pageSize: 15 }),
  });
  return (
    <div>
      <PageHeader title="Visit history" subtitle="All your past queue visits." />
      <Card>
        {isLoading ? (
          <Spinner />
        ) : error || !data ? (
          <ErrorState error={error} retry={refetch} />
        ) : data.items.length === 0 ? (
          <EmptyState icon={<History className="size-12" />} title="No visits yet" />
        ) : (
          <>
            <Table head={['Date', 'Provider', 'Token', 'Joined', 'Waited', 'Status']}>
              {data.items.map((h) => (
                <tr key={h.id}>
                  <Td className="whitespace-nowrap">{date(h.joinedAt)}</Td>
                  <Td>
                    <Link to={`/queues/${h.queue.id}`} className="font-semibold hover:text-brand">
                      {h.queue.doctor?.user.fullName ?? h.queue.service?.name ?? h.queue.name}
                    </Link>
                    <span className="block text-sm text-muted">{h.queue.organization.name}</span>
                  </Td>
                  <Td className="tabular font-semibold">{h.tokenLabel}</Td>
                  <Td>{time(h.joinedAt)}</Td>
                  <Td>{minutes(h.waitedMinutes)}</Td>
                  <Td>
                    <EntryStatusBadge status={h.status} />
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={page} totalPages={data.totalPages} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

interface PatientProfileData {
  dateOfBirth: string | null;
  gender: string | null;
  user: { fullName: string; email: string; phone: string | null };
}

export function PatientProfile() {
  const { reload } = useAuth();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['patient', 'me'], queryFn: () => api.get<PatientProfileData>('/patients/me') });
  const [form, setForm] = useState<{ fullName: string; phone: string; dateOfBirth: string; gender: string } | null>(null);
  const current = form ?? (data && { fullName: data.user.fullName, phone: data.user.phone ?? '', dateOfBirth: data.dateOfBirth?.slice(0, 10) ?? '', gender: data.gender ?? '' });

  const save = useMutation({
    mutationFn: (f: NonNullable<typeof current>) =>
      api.patch('/patients/me', { fullName: f.fullName, phone: f.phone || null, dateOfBirth: f.dateOfBirth || null, gender: f.gender || null }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Profile saved' });
      reload();
    },
  });

  if (isLoading || !current) return <Spinner />;
  const set = (k: keyof typeof current) => (e: { target: { value: string } }) => setForm({ ...current, [k]: e.target.value });
  const submit = (e: FormEvent) => (e.preventDefault(), save.mutate(current));

  return (
    <div>
      <PageHeader title="Profile" subtitle="Keep this short — QFree only needs the basics." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle>Your details</CardTitle>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {save.error && <Alert>{errorMessage(save.error)}</Alert>}
            <Input label="Full name" value={current.fullName} onChange={set('fullName')} required />
            <Input label="Email" value={data!.user.email} disabled hint="Contact support to change your email." />
            <Input label="Mobile number" type="tel" value={current.phone} onChange={set('phone')} />
            <Input label="Date of birth (optional)" type="date" value={current.dateOfBirth} onChange={set('dateOfBirth')} hint="Helps the doctor; never shown publicly." />
            <Select label="Gender (optional)" value={current.gender} onChange={set('gender')}>
              <option value="">Not specified</option>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
              <option value="PREFER_NOT_TO_SAY">Prefer not to say</option>
            </Select>
            <Button type="submit" loading={save.isPending}>
              Save changes
            </Button>
          </form>
        </Card>
        <ChangePasswordCard />
      </div>
    </div>
  );
}
