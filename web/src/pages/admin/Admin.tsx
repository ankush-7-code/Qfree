import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { OrgType, Paged, QueueSnapshot, Role, ServiceCategory } from '../../lib/types';
import { categoryLabel, dateTime, orgTypeLabel, relative } from '../../lib/format';
import { useLiveSnapshots } from '../../hooks/useLive';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Alert, Badge, Card, CardTitle, ErrorState, Input, inputClass, PageHeader, Pagination, Select, Spinner, StatCard, Table, Tabs, Td, Textarea, Toggle } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { QueueBoard } from '../../components/queue/QueueBoard';
import { QueueTile } from '../../components/queue/QueueTile';
import { AnalyticsPanel } from '../../components/charts/AnalyticsPanel';

/** Paged admin listing with debounced search and extra filters. */
function useAdminList<T>(path: string, filters: Record<string, string | undefined> = {}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => (setDebounced(q), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [q]);
  const fkey = JSON.stringify(filters);
  useEffect(() => setPage(1), [fkey]);
  const query = useQuery({
    queryKey: ['admin', path, debounced, page, fkey],
    queryFn: () => api.get<Paged<T>>(path, { q: debounced, page, pageSize: 20, ...filters }),
    placeholderData: keepPreviousData,
  });
  const search = (
    <label className="relative block min-w-60 flex-1">
      <span className="sr-only">Search</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
      <input className={`${inputClass} pl-10`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
    </label>
  );
  return { ...query, page, setPage, search };
}

function ListCard<T>({ list, head, row, toolbar }: { list: ReturnType<typeof useAdminList<T>>; head: string[]; row: (item: T) => ReactNode; toolbar?: ReactNode }) {
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {list.search}
        {toolbar}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error || !list.data ? (
        <ErrorState error={list.error} retry={list.refetch} />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">{list.data.total} total</p>
          <Table head={head} empty={!list.data.items.length}>
            {list.data.items.map(row)}
          </Table>
          <Pagination page={list.page} totalPages={list.data.totalPages} onPage={list.setPage} />
        </>
      )}
    </Card>
  );
}

// ─── Dashboard ───

interface Overview {
  usersByRole: Partial<Record<Role, number>>;
  organizationsByType: Partial<Record<OrgType, number>>;
  openQueues: number;
  pausedQueues: number;
  entriesToday: number;
  waitingNow: number;
  openIssues: number;
  recentAudit: AuditRow[];
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  meta: unknown;
  createdAt: string;
  actor: { fullName: string; email: string; role?: Role } | null;
}

export function AdminDashboard() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.get<Overview>('/admin/overview'), refetchInterval: 30_000 });
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;
  const users = Object.values(data.usersByRole).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <div>
      <PageHeader title="System overview" subtitle="Platform health at a glance. Refreshes every 30 seconds." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Patients waiting now" value={data.waitingNow} />
        <StatCard label="Tokens issued (24 h)" value={data.entriesToday} />
        <StatCard label="Queues open" value={data.openQueues} hint={`${data.pausedQueues} paused`} />
        <StatCard label="Open issues" value={data.openIssues} hint={<Link to="/admin/reports" className="text-brand hover:underline">Review</Link>} />
        <StatCard label="Users" value={users} hint={`${data.usersByRole.PATIENT ?? 0} patients · ${data.usersByRole.DOCTOR ?? 0} doctors`} />
        <StatCard label="Clinics & hospitals" value={(data.organizationsByType.CLINIC ?? 0) + (data.organizationsByType.HOSPITAL ?? 0)} />
        <StatCard label="Laboratories" value={(data.organizationsByType.LABORATORY ?? 0) + (data.organizationsByType.DIAGNOSTIC_CENTER ?? 0)} />
        <StatCard label="Org staff accounts" value={data.usersByRole.ORG_ADMIN ?? 0} />
      </div>
      <Card className="mt-5">
        <CardTitle action={<Link to="/admin/reports?tab=audit" className="font-semibold text-brand hover:underline">Full audit log</Link>}>Recent activity</CardTitle>
        <AuditList rows={data.recentAudit} />
      </Card>
    </div>
  );
}

function AuditList({ rows }: { rows: AuditRow[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
          <span>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-sm">{r.action}</code>{' '}
            <span className="text-ink-2">{r.actor ? `${r.actor.fullName} (${r.actor.email})` : 'System'}</span>
          </span>
          <span className="text-sm text-muted">
            {relative(r.createdAt)}
            {r.ip ? ` · ${r.ip}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ─── Users ───

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export function AdminUsers() {
  const { user: me } = useAuth();
  const [role, setRole] = useState('');
  const list = useAdminList<UserRow>('/admin/users', { role: role || undefined });
  const qc = useQueryClient();
  const toast = useToast();
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<UserRow, 'isActive' | 'role'>> }) => api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', '/admin/users'] });
      toast({ tone: 'success', title: 'User updated' });
    },
    onError: (err) => toast({ tone: 'error', title: 'Update failed', body: errorMessage(err) }),
  });
  return (
    <div>
      <PageHeader title="Users" subtitle="Deactivating a user signs them out everywhere immediately." />
      <ListCard
        list={list}
        toolbar={
          <select className={`${inputClass} w-48`} aria-label="Filter by role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            <option value="PATIENT">Patients</option>
            <option value="DOCTOR">Doctors</option>
            <option value="ORG_ADMIN">Clinic / lab staff</option>
            <option value="ADMIN">Administrators</option>
          </select>
        }
        head={['Name', 'Role', 'Last sign-in', 'Joined', 'Active']}
        row={(u) => (
          <tr key={u.id}>
            <Td>
              <span className="font-semibold">{u.fullName}</span>
              <span className="block text-sm text-muted">{u.email}</span>
            </Td>
            <Td>
              <select
                className={`${inputClass} w-40`}
                aria-label={`Role for ${u.fullName}`}
                value={u.role}
                disabled={u.id === me?.id}
                onChange={(e) => confirm(`Change ${u.fullName}'s role to ${e.target.value}?`) && update.mutate({ id: u.id, body: { role: e.target.value as Role } })}
              >
                <option value="PATIENT">Patient</option>
                <option value="DOCTOR">Doctor</option>
                <option value="ORG_ADMIN">Clinic / lab</option>
                <option value="ADMIN">Admin</option>
              </select>
            </Td>
            <Td className="text-sm">{u.lastLoginAt ? relative(u.lastLoginAt) : 'Never'}</Td>
            <Td className="text-sm">{dateTime(u.createdAt)}</Td>
            <Td>
              <Toggle checked={u.isActive} disabled={u.id === me?.id} onChange={(v) => update.mutate({ id: u.id, body: { isActive: v } })} label={u.isActive ? 'Active' : 'Disabled'} />
            </Td>
          </tr>
        )}
      />
    </div>
  );
}

// ─── Providers ───

interface AdminDoctor {
  id: string;
  specialization: string;
  isAvailable: boolean;
  user: { id: string; fullName: string; email: string; isActive: boolean };
  organization: { id: string; name: string } | null;
  _count: { queues: number };
}

export function AdminDoctors() {
  const list = useAdminList<AdminDoctor>('/admin/doctors');
  return (
    <div>
      <PageHeader title="Doctors" />
      <ListCard
        list={list}
        head={['Doctor', 'Specialization', 'Organization', 'Queues', 'Status']}
        row={(d) => (
          <tr key={d.id}>
            <Td>
              <Link to={`/doctors/${d.id}`} className="font-semibold hover:text-brand">
                {d.user.fullName}
              </Link>
              <span className="block text-sm text-muted">{d.user.email}</span>
            </Td>
            <Td>{d.specialization}</Td>
            <Td>{d.organization ? <Link to={`/providers/${d.organization.id}`} className="hover:text-brand">{d.organization.name}</Link> : <span className="text-muted">Independent</span>}</Td>
            <Td>{d._count.queues}</Td>
            <Td>{!d.user.isActive ? <Badge tone="closed">Disabled</Badge> : d.isAvailable ? <Badge tone="active">Available</Badge> : <Badge tone="paused">Unavailable</Badge>}</Td>
          </tr>
        )}
      />
    </div>
  );
}

interface AdminOrg {
  id: string;
  name: string;
  type: OrgType;
  city: string;
  isVerified: boolean;
  isActive: boolean;
  createdAt: string;
  _count: { doctors: number; services: number; queues: number; staff: number };
}

export function AdminOrganizations({ kind }: { kind: 'clinics' | 'laboratories' }) {
  const types = kind === 'clinics' ? (['CLINIC', 'HOSPITAL'] as const) : (['LABORATORY', 'DIAGNOSTIC_CENTER'] as const);
  const [type, setType] = useState<OrgType>(types[0]);
  useEffect(() => setType(types[0]), [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useAdminList<AdminOrg>('/admin/organizations', { type });
  const qc = useQueryClient();
  const toast = useToast();
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<AdminOrg, 'isVerified' | 'isActive'>> }) => api.patch(`/admin/organizations/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', '/admin/organizations'] }),
    onError: (err) => toast({ tone: 'error', title: 'Update failed', body: errorMessage(err) }),
  });
  return (
    <div>
      <PageHeader title={kind === 'clinics' ? 'Clinics & hospitals' : 'Laboratories & diagnostic centres'} subtitle="Verify providers and suspend them if needed. Suspended providers disappear from search." />
      <ListCard
        list={list}
        toolbar={<Tabs value={type} onChange={setType} options={types.map((t) => ({ value: t, label: orgTypeLabel[t] }))} />}
        head={['Organization', 'City', 'Doctors / services / queues', 'Verified', 'Active']}
        row={(o) => (
          <tr key={o.id}>
            <Td>
              <Link to={`/providers/${o.id}`} className="font-semibold hover:text-brand">
                {o.name}
              </Link>
              <span className="block text-sm text-muted">Since {dateTime(o.createdAt)}</span>
            </Td>
            <Td>{o.city}</Td>
            <Td className="tabular">
              {o._count.doctors} / {o._count.services} / {o._count.queues}
            </Td>
            <Td>
              <Toggle checked={o.isVerified} onChange={(v) => update.mutate({ id: o.id, body: { isVerified: v } })} label={o.isVerified ? 'Verified' : 'No'} />
            </Td>
            <Td>
              <Toggle checked={o.isActive} onChange={(v) => update.mutate({ id: o.id, body: { isActive: v } })} label={o.isActive ? 'Active' : 'Suspended'} />
            </Td>
          </tr>
        )}
      />
    </div>
  );
}

interface AdminService {
  id: string;
  name: string;
  category: ServiceCategory;
  durationMinutes: number;
  price: string | null;
  isActive: boolean;
  organization: { id: string; name: string; type: OrgType };
}

export function AdminServices() {
  const list = useAdminList<AdminService>('/admin/services');
  return (
    <div>
      <PageHeader title="Services" subtitle="All tests and services offered across QFree." />
      <ListCard
        list={list}
        head={['Service', 'Category', 'Provider', 'Duration', 'Price', 'Status']}
        row={(s) => (
          <tr key={s.id}>
            <Td className="font-semibold">{s.name}</Td>
            <Td>{categoryLabel[s.category]}</Td>
            <Td>
              <Link to={`/providers/${s.organization.id}`} className="hover:text-brand">
                {s.organization.name}
              </Link>
            </Td>
            <Td>{s.durationMinutes} min</Td>
            <Td className="tabular">{s.price !== null ? `₹${Number(s.price).toLocaleString()}` : '—'}</Td>
            <Td>{s.isActive ? <Badge tone="active">Active</Badge> : <Badge>Inactive</Badge>}</Td>
          </tr>
        )}
      />
    </div>
  );
}

// ─── Queues ───

export function AdminQueues() {
  const [status, setStatus] = useState<'ALL' | 'OPEN' | 'PAUSED' | 'CLOSED'>('ALL');
  const key = ['admin', 'queues', status] as const;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: QueueSnapshot[] }>('/admin/queues', { status: status === 'ALL' ? undefined : status }),
  });
  useLiveSnapshots(key, data?.items.map((q) => q.id) ?? []);
  return (
    <div>
      <PageHeader title="Queues" subtitle="Every queue on the platform, live." />
      <div className="mb-5">
        <Tabs value={status} onChange={setStatus} options={[{ value: 'ALL', label: 'All' }, { value: 'OPEN', label: 'Open' }, { value: 'PAUSED', label: 'Paused' }, { value: 'CLOSED', label: 'Closed' }]} />
      </div>
      {isLoading ? (
        <Spinner />
      ) : error || !data ? (
        <ErrorState error={error} retry={refetch} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((q) => (
            <div key={q.id}>
              <p className="mb-1 truncate text-sm text-muted">{q.organization.name}</p>
              <QueueTile q={q} to={`/admin/queues/${q.id}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminQueueBoard() {
  const { queueId } = useParams();
  return (
    <div>
      <PageHeader title="Queue (administrator view)" subtitle="Actions here are recorded against your admin account." />
      <QueueBoard queueId={queueId!} detailsBase={`/admin/queues/${queueId}/entries`} />
    </div>
  );
}

// ─── Reports: issues + audit ───

interface IssueRow {
  id: string;
  subject: string;
  description: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  adminNote: string | null;
  createdAt: string;
  reporter: { fullName: string; email: string; role: Role };
}

function Issues() {
  const [status, setStatus] = useState('');
  const list = useAdminList<IssueRow>('/admin/issues', { status: status || undefined });
  const qc = useQueryClient();
  const [edit, setEdit] = useState<IssueRow | null>(null);
  const save = useMutation({
    mutationFn: (i: IssueRow) => api.patch(`/admin/issues/${i.id}`, { status: i.status, adminNote: i.adminNote ?? undefined }),
    onSuccess: () => {
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['admin', '/admin/issues'] });
    },
  });
  const tone = (s: IssueRow['status']) => (s === 'OPEN' ? 'closed' : s === 'IN_PROGRESS' ? 'waiting' : 'active');
  return (
    <>
      <ListCard
        list={list}
        toolbar={
          <select className={`${inputClass} w-44`} aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="RESOLVED">Resolved</option>
            <option value="CLOSED">Closed</option>
          </select>
        }
        head={['Issue', 'Reported by', 'When', 'Status', '']}
        row={(i) => (
          <tr key={i.id}>
            <Td>
              <span className="font-semibold">{i.subject}</span>
              <span className="line-clamp-2 block text-sm text-muted">{i.description}</span>
            </Td>
            <Td className="text-sm">
              {i.reporter.fullName}
              <span className="block text-muted">{i.reporter.role.toLowerCase().replace('_', ' ')}</span>
            </Td>
            <Td className="text-sm">{relative(i.createdAt)}</Td>
            <Td>
              <Badge tone={tone(i.status)}>{i.status.replace('_', ' ').toLowerCase()}</Badge>
            </Td>
            <Td>
              <Button size="sm" variant="ghost" onClick={() => setEdit(i)}>
                Handle
              </Button>
            </Td>
          </tr>
        )}
      />
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.subject ?? ''} footer={<Button loading={save.isPending} onClick={() => edit && save.mutate(edit)}>Save</Button>}>
        {edit && (
          <form className="flex flex-col gap-4" onSubmit={(e: FormEvent) => (e.preventDefault(), save.mutate(edit))}>
            {save.error && <Alert>{errorMessage(save.error)}</Alert>}
            <p className="whitespace-pre-wrap text-ink-2">{edit.description}</p>
            <Select label="Status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value as IssueRow['status'] })}>
              <option value="OPEN">Open</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
            </Select>
            <Textarea label="Reply to reporter" value={edit.adminNote ?? ''} onChange={(e) => setEdit({ ...edit, adminNote: e.target.value })} />
          </form>
        )}
      </Dialog>
    </>
  );
}

function AuditLog() {
  const [action, setAction] = useState('');
  const list = useAdminList<AuditRow>('/admin/audit-logs', { action: action || undefined });
  return (
    <ListCard
      list={list}
      toolbar={
        <select className={`${inputClass} w-52`} aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          <option value="auth.">Authentication</option>
          <option value="queue.">Queue operations</option>
          <option value="patient.">Patient data access</option>
          <option value="organization.">Organizations</option>
          <option value="admin.">Admin actions</option>
        </select>
      }
      head={['When', 'Action', 'Actor', 'Entity', 'Details']}
      row={(r) => (
        <tr key={r.id}>
          <Td className="whitespace-nowrap text-sm">{dateTime(r.createdAt)}</Td>
          <Td>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-sm">{r.action}</code>
          </Td>
          <Td className="text-sm">{r.actor ? r.actor.fullName : 'System'}</Td>
          <Td className="text-sm">
            {r.entityType}
            {r.entityId && <span className="block max-w-40 truncate text-muted">{r.entityId}</span>}
          </Td>
          <Td className="max-w-72 truncate text-sm text-muted">{r.meta ? JSON.stringify(r.meta) : ''}</Td>
        </tr>
      )}
    />
  );
}

export function AdminReports() {
  const initial = new URLSearchParams(location.search).get('tab') === 'audit' ? 'audit' : 'issues';
  const [tab, setTab] = useState<'issues' | 'audit'>(initial);
  return (
    <div>
      <PageHeader title="Reports & issues" subtitle="Problems reported by users, and the audit trail of sensitive actions." />
      <div className="mb-5">
        <Tabs value={tab} onChange={setTab} options={[{ value: 'issues', label: 'Reported issues' }, { value: 'audit', label: 'Audit log' }]} />
      </div>
      {tab === 'issues' ? <Issues /> : <AuditLog />}
    </div>
  );
}

export function AdminAnalytics() {
  return (
    <div>
      <PageHeader title="Platform analytics" subtitle="All organizations combined." />
      <AnalyticsPanel endpoint="/analytics/platform" />
    </div>
  );
}

// ─── Settings ───

interface Settings {
  maxActiveQueuesPerPatient: number;
  enforceOperatingHours: boolean;
  maxUpcomingBookingsPerPatient: number;
  allowJoinWhilePaused: boolean;
  maintenanceMessage: string;
}

export function AdminSettings() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<Settings>('/admin/settings') });
  const [s, setS] = useState<Settings | null>(null);
  const cur = s ?? data;
  const save = useMutation({
    mutationFn: (body: Settings) => api.put<Settings>('/admin/settings', body),
    onSuccess: (res) => {
      qc.setQueryData(['admin', 'settings'], res);
      setS(null);
      toast({ tone: 'success', title: 'Settings saved' });
    },
  });
  if (isLoading || !cur) return <Spinner />;
  return (
    <div>
      <PageHeader title="System settings" subtitle="Rules applied across every queue on the platform." />
      <Card className="max-w-2xl">
        <form onSubmit={(e: FormEvent) => (e.preventDefault(), save.mutate(cur))} className="flex flex-col gap-5">
          {save.error && <Alert>{errorMessage(save.error)}</Alert>}
          <Input
            label="Maximum queues a patient can be in at once"
            type="number"
            min={1}
            max={10}
            value={cur.maxActiveQueuesPerPatient}
            onChange={(e) => setS({ ...cur, maxActiveQueuesPerPatient: Number(e.target.value) })}
            hint="Stops people from holding places in many queues."
          />
          <Input
            label="Maximum upcoming bookings per patient"
            type="number"
            min={1}
            max={20}
            value={cur.maxUpcomingBookingsPerPatient}
            onChange={(e) => setS({ ...cur, maxUpcomingBookingsPerPatient: Number(e.target.value) })}
            hint="Stops one person from reserving many future appointments."
          />
          <Toggle checked={cur.enforceOperatingHours} onChange={(v) => setS({ ...cur, enforceOperatingHours: v })} label="Require confirmation to open queues outside operating hours" />
          <Toggle checked={cur.allowJoinWhilePaused} onChange={(v) => setS({ ...cur, allowJoinWhilePaused: v })} label="Allow patients to join paused queues" />
          <Textarea label="Maintenance message (optional)" maxLength={300} value={cur.maintenanceMessage} onChange={(e) => setS({ ...cur, maintenanceMessage: e.target.value })} />
          <Button type="submit" loading={save.isPending}>
            Save settings
          </Button>
        </form>
      </Card>
    </div>
  );
}
