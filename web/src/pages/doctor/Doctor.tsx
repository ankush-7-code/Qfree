import { useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Settings2, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { EntryStatus, Paged, QueueSnapshot } from '../../lib/types';
import { DAYS, minutes, time } from '../../lib/format';
import { useLiveSnapshots } from '../../hooks/useLive';
import { Button, LinkButton } from '../../components/ui/Button';
import { Alert, Card, CardTitle, EmptyState, ErrorState, Input, inputClass, PageHeader, Pagination, Select, Spinner, StatCard, Table, Td, Textarea, Toggle } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { QueueBoard } from '../../components/queue/QueueBoard';
import { QueueFormDialog } from '../../components/queue/QueueForm';
import { QueueTile } from '../../components/queue/QueueTile';
import { EntryStatusBadge } from '../../components/queue/Status';
import { AnalyticsPanel } from '../../components/charts/AnalyticsPanel';
import { ChangePasswordCard } from '../shared/Shared';

interface DoctorMe {
  id: string;
  specialization: string;
  qualification: string | null;
  experienceYears: number;
  bio: string | null;
  consultationMinutes: number;
  isAvailable: boolean;
  user: { fullName: string; email: string; phone: string | null };
  organization: { id: string; name: string; type: string; city: string } | null;
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  queues: QueueSnapshot[];
}

const ME_KEY = ['doctor', 'me'] as const;
const useDoctorMe = () => useQuery({ queryKey: ME_KEY, queryFn: () => api.get<DoctorMe>('/doctors/me') });

export function DoctorDashboard() {
  const { data: me, isLoading, error, refetch } = useDoctorMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  useLiveSnapshots(ME_KEY, me?.queues.map((q) => q.id) ?? []);

  const availability = useMutation({
    mutationFn: (isAvailable: boolean) => api.patch('/doctors/me/availability', { isAvailable }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
    onError: (err) => toast({ tone: 'error', title: 'Could not update availability', body: errorMessage(err) }),
  });

  if (isLoading) return <Spinner />;
  if (error || !me) return <ErrorState error={error} retry={refetch} />;

  const served = me.queues.reduce((n, q) => n + q.servedCount, 0);
  const waiting = me.queues.reduce((n, q) => n + q.waitingCount, 0);

  return (
    <div>
      <PageHeader
        title={`Good day, ${me.user.fullName}`}
        subtitle={me.organization ? `${me.specialization} · ${me.organization.name}` : me.specialization}
        actions={<Toggle checked={me.isAvailable} onChange={(v) => availability.mutate(v)} label={me.isAvailable ? 'Available' : 'Unavailable'} disabled={availability.isPending} />}
      />
      {!me.organization ? (
        <Card>
          <EmptyState
            icon={<Building2 className="size-12" />}
            title="Connect to a clinic to start a queue"
            action={
              <LinkButton to="/doctor/setup" size="lg">
                Set up my practice
              </LinkButton>
            }
          >
            Create your own practice profile, or ask your clinic's administrator to add you using your email ({me.user.email}).
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Waiting now" value={waiting} />
            <StatCard label="Served today" value={served} />
            <StatCard label="Avg per patient" value={me.queues[0] ? minutes(me.queues[0].avgServiceMinutes) : '—'} />
            <StatCard label="Queues" value={me.queues.length} />
          </div>
          <Card className="mt-5">
            <CardTitle
              action={
                <Button variant="secondary" icon={<Plus className="size-5" />} onClick={() => setCreating(true)}>
                  New queue
                </Button>
              }
            >
              My queues
            </CardTitle>
            {me.queues.length === 0 ? (
              <EmptyState title="No queue yet" action={<Button onClick={() => setCreating(true)}>Create my queue</Button>}>
                A queue lets patients take a digital token and follow their turn.
              </EmptyState>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {me.queues.map((q) => (
                  <QueueTile key={q.id} q={q} to={`/doctor/queue/${q.id}`} />
                ))}
              </div>
            )}
          </Card>
          <QueueFormDialog
            key={String(creating)}
            open={creating}
            onClose={() => setCreating(false)}
            onSaved={() => qc.invalidateQueries({ queryKey: ME_KEY })}
            organizationId={me.organization.id}
            fixedDoctorId={me.id}
          />
        </>
      )}
    </div>
  );
}

export function DoctorQueue() {
  const { queueId } = useParams();
  const { data: me, isLoading } = useDoctorMe();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  if (isLoading || !me) return <Spinner />;
  if (!queueId) {
    if (me.queues.length === 1) return <Navigate to={`/doctor/queue/${me.queues[0].id}`} replace />;
    return (
      <div>
        <PageHeader title="Today's queue" subtitle="Choose a queue to manage." />
        {me.queues.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {me.queues.map((q) => (
              <QueueTile key={q.id} q={q} to={`/doctor/queue/${q.id}`} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState title="No queue yet" action={<LinkButton to="/doctor">Go to dashboard</LinkButton>} />
          </Card>
        )}
      </div>
    );
  }
  const queue = me.queues.find((q) => q.id === queueId);
  return (
    <div>
      <PageHeader
        title={queue?.name ?? "Today's queue"}
        subtitle="Patients update live. Calling the next patient notifies them instantly."
        actions={
          queue && (
            <Button variant="ghost" icon={<Settings2 className="size-5" />} onClick={() => setEditing(true)}>
              Queue settings
            </Button>
          )
        }
      />
      <QueueBoard queueId={queueId} detailsBase={`/doctor/queue/${queueId}/entries`} />
      {queue && me.organization && (
        <QueueFormDialog
          key={`${editing}`}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ME_KEY })}
          organizationId={me.organization.id}
          queue={queue}
          fixedDoctorId={me.id}
        />
      )}
    </div>
  );
}

interface HistoryRow {
  id: string;
  tokenLabel: string;
  status: EntryStatus;
  sessionDate: string;
  joinedAt: string;
  calledAt: string | null;
  completedAt: string | null;
  patientName: string;
}

/** Past sessions of a queue with a date filter. Used by doctors and organizations. */
export function QueueHistoryView({ queues }: { queues: { id: string; name: string }[] }) {
  const [queueId, setQueueId] = useState(queues[0]?.id ?? '');
  const [day, setDay] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['queue-history', queueId, day, page],
    queryFn: () => api.get<Paged<HistoryRow>>(`/queues/${queueId}/history`, { date: day, page, pageSize: 25 }),
    enabled: !!queueId,
  });
  if (!queues.length) return <EmptyState title="No queues yet" />;
  return (
    <Card>
      <div className="mb-4 flex flex-wrap gap-3">
        {queues.length > 1 && (
          <Select label="Queue" value={queueId} onChange={(e) => (setQueueId(e.target.value), setPage(1))} className="min-w-60">
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">Date</span>
          <input type="date" className={inputClass} value={day} onChange={(e) => (setDay(e.target.value), setPage(1))} />
        </label>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error || !data ? (
        <ErrorState error={error} retry={refetch} />
      ) : (
        <>
          <Table head={['Date', 'Token', 'Patient', 'Joined', 'Called', 'Waited', 'Consult', 'Status']} empty={!data.items.length}>
            {data.items.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{r.sessionDate}</Td>
                <Td className="tabular font-semibold">{r.tokenLabel}</Td>
                <Td>{r.patientName}</Td>
                <Td>{time(r.joinedAt)}</Td>
                <Td>{time(r.calledAt)}</Td>
                <Td>{r.calledAt ? minutes((new Date(r.calledAt).getTime() - new Date(r.joinedAt).getTime()) / 60000) : '—'}</Td>
                <Td>{r.calledAt && r.completedAt ? minutes((new Date(r.completedAt).getTime() - new Date(r.calledAt).getTime()) / 60000) : '—'}</Td>
                <Td>
                  <EntryStatusBadge status={r.status} />
                </Td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} totalPages={data.totalPages} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

export function DoctorHistory() {
  const { data: me, isLoading } = useDoctorMe();
  if (isLoading || !me) return <Spinner />;
  return (
    <div>
      <PageHeader title="Queue history" subtitle="Every token issued in your queues." />
      <QueueHistoryView queues={me.queues} />
    </div>
  );
}

type Slot = { dayOfWeek: number; startTime: string; endTime: string };

export function DoctorSchedule() {
  const { data: me, isLoading } = useDoctorMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const current = slots ?? me?.schedules ?? [];
  const save = useMutation({
    mutationFn: () => api.put('/doctors/me/schedule', current),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Schedule saved' });
      qc.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: (err) => toast({ tone: 'error', title: 'Could not save', body: errorMessage(err) }),
  });
  if (isLoading) return <Spinner />;
  const update = (i: number, patch: Partial<Slot>) => setSlots(current.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div>
      <PageHeader title="Schedule" subtitle="Consultation timings shown to patients on your profile." actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save schedule</Button>} />
      <div className="grid gap-4 md:grid-cols-2">
        {DAYS.map((day, d) => {
          const daySlots = current.map((s, i) => ({ s, i })).filter(({ s }) => s.dayOfWeek === d);
          return (
            <Card key={day}>
              <CardTitle action={<Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setSlots([...current, { dayOfWeek: d, startTime: '09:00', endTime: '13:00' }])}>Add slot</Button>}>
                {day}
              </CardTitle>
              {daySlots.length === 0 ? (
                <p className="text-muted">Not available</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {daySlots.map(({ s, i }) => (
                    <li key={i} className="flex items-center gap-2">
                      <input type="time" aria-label={`${day} start`} className={inputClass} value={s.startTime} onChange={(e) => update(i, { startTime: e.target.value })} />
                      <span aria-hidden>–</span>
                      <input type="time" aria-label={`${day} end`} className={inputClass} value={s.endTime} onChange={(e) => update(i, { endTime: e.target.value })} />
                      <button className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-st-closed" onClick={() => setSlots(current.filter((_, j) => j !== i))} aria-label={`Remove ${day} slot`}>
                        <Trash2 className="size-5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function DoctorAnalytics() {
  return (
    <div>
      <PageHeader title="Analytics" subtitle="How your queues are performing." />
      <AnalyticsPanel endpoint="/analytics/doctor" />
    </div>
  );
}

export function DoctorProfile() {
  const { data: me, isLoading } = useDoctorMe();
  const { reload } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string> | null>(null);
  const form =
    f ??
    (me && {
      fullName: me.user.fullName,
      phone: me.user.phone ?? '',
      specialization: me.specialization,
      qualification: me.qualification ?? '',
      experienceYears: String(me.experienceYears),
      consultationMinutes: String(me.consultationMinutes),
      bio: me.bio ?? '',
    });
  const save = useMutation({
    mutationFn: () =>
      api.patch('/doctors/me', { ...form, phone: form!.phone || undefined, experienceYears: Number(form!.experienceYears), consultationMinutes: Number(form!.consultationMinutes) }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Profile saved' });
      qc.invalidateQueries({ queryKey: ME_KEY });
      reload();
    },
  });
  if (isLoading || !form || !me) return <Spinner />;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...form, [k]: e.target.value });

  return (
    <div>
      <PageHeader title="Profile" subtitle="Shown to patients on your public page." actions={<Link className="font-semibold text-brand hover:underline" to={`/doctors/${me.id}`}>View public profile</Link>} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <form onSubmit={(e: FormEvent) => (e.preventDefault(), save.mutate())} className="flex flex-col gap-4">
            {save.error && <Alert>{errorMessage(save.error)}</Alert>}
            <Input label="Full name" required value={form.fullName} onChange={set('fullName')} />
            <Input label="Phone" type="tel" value={form.phone} onChange={set('phone')} />
            <Input label="Specialization" required value={form.specialization} onChange={set('specialization')} />
            <Input label="Qualification" value={form.qualification} onChange={set('qualification')} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Years of experience" type="number" min={0} max={70} value={form.experienceYears} onChange={set('experienceYears')} />
              <Input label="Typical consultation (min)" type="number" min={1} max={120} value={form.consultationMinutes} onChange={set('consultationMinutes')} />
            </div>
            <Textarea label="About you" maxLength={2000} value={form.bio} onChange={set('bio')} />
            <Button type="submit" loading={save.isPending}>
              Save profile
            </Button>
          </form>
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <CardTitle>Organization</CardTitle>
            {me.organization ? (
              <p>
                {me.organization.name} · {me.organization.city}
              </p>
            ) : (
              <LinkButton to="/doctor/setup">Set up my practice</LinkButton>
            )}
          </Card>
          <ChangePasswordCard />
        </div>
      </div>
    </div>
  );
}
