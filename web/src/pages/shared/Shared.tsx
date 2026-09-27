import clsx from 'clsx';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bell, CheckCheck } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { EntryStatus, Notification, Paged, Priority } from '../../lib/types';
import { date, dateTime, priorityLabel, relative } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Alert, Badge, Card, CardTitle, EmptyState, ErrorState, Input, PageHeader, Pagination, Spinner, Textarea } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { EntryStatusBadge } from '../../components/queue/Status';

export function Notifications() {
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['notifications', 'list', page],
    queryFn: () => api.get<Paged<Notification> & { unread: number }>('/notifications', { page, pageSize: 20 }),
  });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const open = async (n: Notification) => {
    if (!n.readAt) {
      await api.patch(`/notifications/${n.id}/read`, {});
      qc.invalidateQueries({ queryKey: ['notifications'] });
    }
    if (n.data?.queueId && user?.role === 'PATIENT') navigate(`/queues/${n.data.queueId}`);
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={data ? `${data.unread} unread` : undefined}
        actions={
          <Button variant="secondary" icon={<CheckCheck className="size-5" />} onClick={() => readAll.mutate()} disabled={!data?.unread}>
            Mark all as read
          </Button>
        }
      />
      <Card>
        {isLoading ? (
          <Spinner />
        ) : error || !data ? (
          <ErrorState error={error} retry={refetch} />
        ) : data.items.length === 0 ? (
          <EmptyState icon={<Bell className="size-12" />} title="No notifications yet">
            Queue updates such as “your turn is approaching” appear here.
          </EmptyState>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {data.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => open(n)} className={clsx('flex w-full gap-3 rounded-xl p-3 text-left hover:bg-surface-2', !n.readAt && 'bg-brand-soft/50')}>
                  <span className={clsx('mt-2 size-2.5 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">
                        {n.title}
                        {!n.readAt && <span className="sr-only"> (unread)</span>}
                      </span>
                      <span className="text-sm text-muted">{relative(n.createdAt)}</span>
                    </span>
                    <span className="block text-ink-2">{n.body}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && <Pagination page={page} totalPages={data.totalPages} onPage={setPage} />}
      </Card>
    </div>
  );
}

export function ChangePasswordCard() {
  const toast = useToast();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const m = useMutation({
    mutationFn: () => api.post('/auth/change-password', f),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Password changed', body: 'Please sign in again with your new password.' });
      await logout();
      navigate('/login');
    },
  });
  return (
    <Card>
      <CardTitle>Change password</CardTitle>
      <form onSubmit={(e: FormEvent) => (e.preventDefault(), m.mutate())} className="flex flex-col gap-4">
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <Input label="Current password" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters with a letter and a number. You'll be signed out everywhere."
          value={f.newPassword}
          onChange={(e) => setF({ ...f, newPassword: e.target.value })}
        />
        <Button type="submit" variant="secondary" loading={m.isPending}>
          Update password
        </Button>
      </form>
    </Card>
  );
}

export function ReportIssue() {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ subject: '', description: '' });
  const mine = useQuery({ queryKey: ['issues', 'mine'], queryFn: () => api.get<Paged<{ id: string; subject: string; status: string; adminNote: string | null; createdAt: string }>>('/issues/mine') });
  const m = useMutation({
    mutationFn: () => api.post('/issues', f),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Thanks — we received your report' });
      setF({ subject: '', description: '' });
      qc.invalidateQueries({ queryKey: ['issues'] });
    },
  });
  return (
    <div>
      <PageHeader title="Report a problem" subtitle="Tell us what went wrong. An administrator will look into it." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <form onSubmit={(e: FormEvent) => (e.preventDefault(), m.mutate())} className="flex flex-col gap-4">
            {m.error && <Alert>{errorMessage(m.error)}</Alert>}
            <Input label="Subject" required minLength={3} maxLength={150} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
            <Textarea label="What happened?" required minLength={10} maxLength={4000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <Button type="submit" loading={m.isPending}>
              Send report
            </Button>
          </form>
        </Card>
        <Card>
          <CardTitle>Your reports</CardTitle>
          {mine.data?.items.length ? (
            <ul className="divide-y divide-line">
              {mine.data.items.map((i) => (
                <li key={i.id} className="py-3">
                  <p className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                    {i.subject} <Badge tone={i.status === 'RESOLVED' || i.status === 'CLOSED' ? 'active' : 'waiting'}>{i.status.replace('_', ' ').toLowerCase()}</Badge>
                  </p>
                  <p className="text-sm text-muted">{date(i.createdAt)}</p>
                  {i.adminNote && <p className="mt-1 text-ink-2">Reply: {i.adminNote}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2">No reports yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

interface EntryDetailData {
  id: string;
  tokenLabel: string;
  status: EntryStatus;
  priority: Priority;
  skipCount: number;
  note: string | null;
  joinedAt: string;
  calledAt: string | null;
  completedAt: string | null;
  patient: { name: string; phone: string | null; email: string; dateOfBirth: string | null; gender: string | null };
  timeline: { type: string; at: string; by: string; meta: Record<string, unknown> | null }[];
  previousVisits: { id: string; tokenLabel: string; completedAt: string | null; queue: { name: string } }[];
}

/** Patient details for staff: minimal identity, this visit's timeline, previous visits here. */
export function EntryDetails() {
  const { queueId, entryId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['entry', entryId],
    queryFn: () => api.get<EntryDetailData>(`/queues/${queueId}/entries/${entryId}`),
  });
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;
  const age = data.patient.dateOfBirth ? Math.floor((Date.now() - new Date(data.patient.dateOfBirth).getTime()) / 31_557_600_000) : null;

  return (
    <div>
      <button onClick={() => navigate(-1)} className="mb-4 flex items-center gap-2 font-semibold text-brand hover:underline">
        <ArrowLeft className="size-5" aria-hidden /> Back to queue
      </button>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="tabular">{data.tokenLabel}</span> <span className="text-ink-2">·</span> {data.patient.name}
          </span>
        }
        actions={
          <div className="flex gap-2">
            <EntryStatusBadge status={data.status} />
            {data.priority !== 'NORMAL' && <Badge tone={data.priority === 'EMERGENCY' ? 'closed' : 'approach'}>{priorityLabel[data.priority]}</Badge>}
          </div>
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle>Patient</CardTitle>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2">
            <dt className="text-ink-2">Age</dt>
            <dd>{age ?? '—'}</dd>
            <dt className="text-ink-2">Gender</dt>
            <dd>{data.patient.gender ? data.patient.gender.replace(/_/g, ' ').toLowerCase() : '—'}</dd>
            <dt className="text-ink-2">Phone</dt>
            <dd>{data.patient.phone ? <a className="text-brand hover:underline" href={`tel:${data.patient.phone.replace(/\s/g, '')}`}>{data.patient.phone}</a> : '—'}</dd>
            <dt className="text-ink-2">Email</dt>
            <dd className="break-all">{data.patient.email}</dd>
            {data.note && (
              <>
                <dt className="text-ink-2">Note</dt>
                <dd>{data.note}</dd>
              </>
            )}
          </dl>
          <p className="mt-4 text-sm text-muted">Viewing patient details is recorded in the audit log.</p>
        </Card>
        <Card>
          <CardTitle>This visit</CardTitle>
          <ol className="relative ml-2 border-l-2 border-line">
            {data.timeline.map((t, i) => (
              <li key={i} className="mb-3 ml-4">
                <span className="absolute -left-[7px] mt-1.5 size-3 rounded-full bg-brand" aria-hidden />
                <p className="font-semibold">{t.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</p>
                <p className="text-sm text-muted">
                  {dateTime(t.at)} · {t.by}
                  {t.meta && typeof t.meta.reason === 'string' ? ` · ${t.meta.reason}` : ''}
                </p>
              </li>
            ))}
          </ol>
        </Card>
        <Card className="lg:col-span-2">
          <CardTitle>Previous visits here</CardTitle>
          {data.previousVisits.length ? (
            <ul className="divide-y divide-line">
              {data.previousVisits.map((v) => (
                <li key={v.id} className="flex justify-between py-2">
                  <span>
                    {v.queue.name} · <span className="tabular">{v.tokenLabel}</span>
                  </span>
                  <span className="text-ink-2">{date(v.completedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2">First visit.</p>
          )}
        </Card>
      </div>
      <p className="mt-6 text-sm text-muted">
        Something wrong? <Link to="/report-issue" className="text-brand hover:underline">Report an issue</Link>.
      </p>
    </div>
  );
}
