import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Analytics, Hours, OrgType, QueueSnapshot, Service, ServiceCategory, StaffRole } from '../../lib/types';
import { categoryLabel, DAYS, isoDay, minutes, orgTypeLabel, staffRoleLabel } from '../../lib/format';
import { useLiveSnapshots } from '../../hooks/useLive';
import { Button, LinkButton } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Alert, Badge, Card, CardTitle, EmptyState, ErrorState, Input, inputClass, PageHeader, Select, Spinner, StatCard, Table, Td, Textarea } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { QueueBoard } from '../../components/queue/QueueBoard';
import { QueueFormDialog } from '../../components/queue/QueueForm';
import { QueueTile } from '../../components/queue/QueueTile';
import { AnalyticsPanel } from '../../components/charts/AnalyticsPanel';
import { QueueHistoryView } from '../doctor/Doctor';

// ─── Current organization ───

const ORG_KEY = 'qfree.org';

function useCurrentOrgId() {
  const { user } = useAuth();
  const orgs = user?.organizations ?? [];
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ORG_KEY);
    } catch {
      return null;
    }
  });
  const id = orgs.find((o) => o.id === selected)?.id ?? orgs[0]?.id ?? null;
  const select = (v: string) => {
    setSelected(v);
    try {
      localStorage.setItem(ORG_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  return { id, orgs, select, role: orgs.find((o) => o.id === id)?.staffRole };
}

interface ManagedOrg {
  id: string;
  name: string;
  type: OrgType;
  description: string | null;
  address: string;
  city: string;
  phone: string | null;
  email: string | null;
  timezone: string;
  isVerified: boolean;
  hours: Hours[];
  doctors: { id: string; specialization: string; isAvailable: boolean; experienceYears: number; user: { fullName: string; email: string; phone: string | null } }[];
  services: (Service & { isActive: boolean })[];
  queues: QueueSnapshot[];
  staff: { id: string; staffRole: StaffRole; user: { id: string; fullName: string; email: string; phone: string | null } }[];
}

const orgKey = (id: string | null) => ['org', id, 'manage'] as const;

function useManagedOrg() {
  const cur = useCurrentOrgId();
  const query = useQuery({ queryKey: orgKey(cur.id), queryFn: () => api.get<ManagedOrg>(`/organizations/${cur.id}/manage`), enabled: !!cur.id });
  return { ...cur, ...query };
}

/** Wraps an org page: handles "no organization yet", loading and errors. */
function OrgPage({ children }: { children: (org: ManagedOrg, ctx: ReturnType<typeof useManagedOrg>) => React.ReactNode }) {
  const ctx = useManagedOrg();
  if (!ctx.id) return <Navigate to="/org/setup" replace />;
  if (ctx.isLoading) return <Spinner />;
  if (ctx.error || !ctx.data) return <ErrorState error={ctx.error} retry={ctx.refetch} />;
  return <>{children(ctx.data, ctx)}</>;
}

function OrgSwitcher() {
  const { id, orgs, select } = useCurrentOrgId();
  if (orgs.length < 2) return null;
  return (
    <label className="flex items-center gap-2">
      <span className="text-sm text-ink-2">Organization</span>
      <select className={inputClass} value={id ?? ''} onChange={(e) => select(e.target.value)}>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ─── Dashboard ───

export function OrgDashboard() {
  const ctx = useManagedOrg();
  useLiveSnapshots(orgKey(ctx.id), ctx.data?.queues.map((q) => q.id) ?? []);
  return (
    <OrgPage>
      {(org) => {
        const open = org.queues.filter((q) => q.status !== 'CLOSED');
        const waiting = org.queues.reduce((n, q) => n + q.waitingCount, 0);
        const served = org.queues.reduce((n, q) => n + q.servedCount, 0);
        const longest = [...open].sort((a, b) => b.estimatedWaitMinutes - a.estimatedWaitMinutes)[0];
        return (
          <div>
            <PageHeader title={org.name} subtitle={`${orgTypeLabel[org.type]} · ${org.city}`} actions={<OrgSwitcher />} />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Active queues" value={`${open.length} / ${org.queues.length}`} />
              <StatCard label="Patients waiting" value={waiting} />
              <StatCard label="Served today" value={served} />
              <StatCard label="Longest wait" value={longest ? minutes(longest.estimatedWaitMinutes) : '—'} hint={longest?.name} />
            </div>
            <Card className="mt-5">
              <CardTitle action={<LinkButton to="/org/queues" variant="secondary">Manage queues</LinkButton>}>All queues — live</CardTitle>
              {org.queues.length ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {org.queues.map((q) => (
                    <QueueTile key={q.id} q={q} to={`/org/queues/${q.id}`} />
                  ))}
                </div>
              ) : (
                <EmptyState title="No queues yet" action={<LinkButton to="/org/queues">Create a queue</LinkButton>}>
                  Add doctors or services, then create a queue for each.
                </EmptyState>
              )}
            </Card>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <StatCard label="Doctors" value={org.doctors.length} hint={<Link className="text-brand hover:underline" to="/org/doctors">Manage</Link>} />
              <StatCard label="Services" value={org.services.filter((s) => s.isActive).length} hint={<Link className="text-brand hover:underline" to="/org/services">Manage</Link>} />
              <StatCard label="Staff" value={org.staff.length} hint={<Link className="text-brand hover:underline" to="/org/staff">Manage</Link>} />
            </div>
          </div>
        );
      }}
    </OrgPage>
  );
}

// ─── Queues ───

export function OrgQueues() {
  const qc = useQueryClient();
  const toast = useToast();
  const ctx = useManagedOrg();
  const [edit, setEdit] = useState<QueueSnapshot | 'new' | null>(null);
  useLiveSnapshots(orgKey(ctx.id), ctx.data?.queues.map((q) => q.id) ?? []);
  const archive = useMutation({
    mutationFn: (id: string) => api.del(`/queues/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(ctx.id) }),
    onError: (err) => toast({ tone: 'error', title: 'Could not archive', body: errorMessage(err) }),
  });
  return (
    <OrgPage>
      {(org) => (
        <div>
          <PageHeader title="Queues" subtitle="One queue per doctor or service." actions={<Button icon={<Plus className="size-5" />} onClick={() => setEdit('new')}>New queue</Button>} />
          {org.queues.length === 0 ? (
            <Card>
              <EmptyState title="No queues yet" />
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {org.queues.map((q) => (
                <div key={q.id} className="flex flex-col gap-2">
                  <QueueTile q={q} to={`/org/queues/${q.id}`} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEdit(q)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} disabled={q.status !== 'CLOSED'} title={q.status !== 'CLOSED' ? 'Close the queue first' : undefined} onClick={() => archive.mutate(q.id)}>
                      Archive
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {edit && (
            <QueueFormDialog
              open
              onClose={() => setEdit(null)}
              onSaved={() => qc.invalidateQueries({ queryKey: orgKey(ctx.id) })}
              organizationId={org.id}
              queue={edit === 'new' ? undefined : edit}
              doctors={org.doctors.map((d) => ({ id: d.id, label: `${d.user.fullName} — ${d.specialization}` }))}
              services={org.services.filter((s) => s.isActive).map((s) => ({ id: s.id, label: s.name }))}
            />
          )}
        </div>
      )}
    </OrgPage>
  );
}

export function OrgQueueBoard() {
  const { queueId } = useParams();
  const ctx = useManagedOrg();
  const q = ctx.data?.queues.find((x) => x.id === queueId);
  return (
    <div>
      <PageHeader title={q?.name ?? 'Queue'} subtitle={q?.doctor ? `${q.doctor.name} · ${q.doctor.specialization}` : q?.service?.name} />
      <QueueBoard queueId={queueId!} detailsBase={`/org/queues/${queueId}/entries`} />
    </div>
  );
}

// ─── Doctors ───

export function OrgDoctors() {
  const qc = useQueryClient();
  const toast = useToast();
  const ctx = useManagedOrg();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: '', fullName: '', password: '', specialization: '', qualification: '' });
  const add = useMutation({
    mutationFn: () => api.post(`/organizations/${ctx.id}/doctors`, Object.fromEntries(Object.entries(f).filter(([, v]) => v))),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Doctor added' });
      setOpen(false);
      setF({ email: '', fullName: '', password: '', specialization: '', qualification: '' });
      qc.invalidateQueries({ queryKey: orgKey(ctx.id) });
    },
  });
  const remove = useMutation({
    mutationFn: (doctorId: string) => api.del(`/organizations/${ctx.id}/doctors/${doctorId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(ctx.id) }),
    onError: (err) => toast({ tone: 'error', title: 'Could not remove doctor', body: errorMessage(err) }),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <OrgPage>
      {(org) => (
        <div>
          <PageHeader title="Doctors" actions={<Button icon={<UserPlus className="size-5" />} onClick={() => setOpen(true)}>Add doctor</Button>} />
          <Card>
            <Table head={['Doctor', 'Specialization', 'Experience', 'Status', '']} empty={!org.doctors.length}>
              {org.doctors.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <Link to={`/doctors/${d.id}`} className="font-semibold hover:text-brand">
                      {d.user.fullName}
                    </Link>
                    <span className="block text-sm text-muted">{d.user.email}</span>
                  </Td>
                  <Td>{d.specialization}</Td>
                  <Td>{d.experienceYears} yrs</Td>
                  <Td>{d.isAvailable ? <Badge tone="active">Available</Badge> : <Badge tone="paused">Unavailable</Badge>}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${d.user.fullName} from ${org.name}? Their queues will be archived.`) && remove.mutate(d.id)}>
                      Remove
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Dialog open={open} onClose={() => setOpen(false)} title="Add a doctor" footer={<Button type="submit" form="doc-form" loading={add.isPending}>Add doctor</Button>}>
            <form id="doc-form" onSubmit={(e: FormEvent) => (e.preventDefault(), add.mutate())} className="flex flex-col gap-4">
              {add.error && <Alert>{errorMessage(add.error)}</Alert>}
              <Input label="Doctor's email" type="email" required value={f.email} onChange={set('email')} hint="If the doctor already has a QFree account, that's all we need." />
              <details>
                <summary className="cursor-pointer font-medium text-brand">Create a new doctor account instead</summary>
                <div className="mt-3 flex flex-col gap-4">
                  <Input label="Full name" value={f.fullName} onChange={set('fullName')} />
                  <Input label="Temporary password" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} hint="Share it securely; the doctor can change it later." />
                  <Input label="Specialization" value={f.specialization} onChange={set('specialization')} />
                  <Input label="Qualification" value={f.qualification} onChange={set('qualification')} />
                </div>
              </details>
            </form>
          </Dialog>
        </div>
      )}
    </OrgPage>
  );
}

// ─── Services ───

type ServiceForm = { id?: string; name: string; category: ServiceCategory; description: string; durationMinutes: string; price: string };
const emptyService: ServiceForm = { name: '', category: 'LAB_TEST', description: '', durationMinutes: '10', price: '' };

export function OrgServices() {
  const qc = useQueryClient();
  const toast = useToast();
  const ctx = useManagedOrg();
  const [form, setForm] = useState<ServiceForm | null>(null);
  const save = useMutation({
    mutationFn: (s: ServiceForm) => {
      const body = { name: s.name, category: s.category, description: s.description || undefined, durationMinutes: Number(s.durationMinutes), price: s.price ? Number(s.price) : null };
      return s.id ? api.patch(`/organizations/${ctx.id}/services/${s.id}`, body) : api.post(`/organizations/${ctx.id}/services`, body);
    },
    onSuccess: () => {
      setForm(null);
      qc.invalidateQueries({ queryKey: orgKey(ctx.id) });
    },
  });
  const toggle = useMutation({
    mutationFn: (s: Service & { isActive: boolean }) => api.patch(`/organizations/${ctx.id}/services/${s.id}`, { isActive: !s.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(ctx.id) }),
    onError: (err) => toast({ tone: 'error', title: 'Update failed', body: errorMessage(err) }),
  });
  const set = (k: keyof ServiceForm) => (e: { target: { value: string } }) => setForm({ ...form!, [k]: e.target.value });

  return (
    <OrgPage>
      {(org) => (
        <div>
          <PageHeader title="Services & tests" subtitle="Laboratory tests, diagnostics and consultations you offer." actions={<Button icon={<Plus className="size-5" />} onClick={() => setForm(emptyService)}>Add service</Button>} />
          <Card>
            <Table head={['Service', 'Category', 'Duration', 'Price', 'Status', '']} empty={!org.services.length}>
              {org.services.map((s) => (
                <tr key={s.id} className={s.isActive ? '' : 'opacity-60'}>
                  <Td>
                    <span className="font-semibold">{s.name}</span>
                    {s.description && <span className="block text-sm text-muted">{s.description}</span>}
                  </Td>
                  <Td>{categoryLabel[s.category]}</Td>
                  <Td>{s.durationMinutes} min</Td>
                  <Td className="tabular">{s.price !== null ? `₹${Number(s.price).toLocaleString()}` : '—'}</Td>
                  <Td>{s.isActive ? <Badge tone="active">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => setForm({ id: s.id, name: s.name, category: s.category, description: s.description ?? '', durationMinutes: String(s.durationMinutes), price: s.price !== null ? String(s.price) : '' })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)}>
                      {s.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Dialog open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit service' : 'Add service'} footer={<Button type="submit" form="svc-form" loading={save.isPending}>Save</Button>}>
            {form && (
              <form id="svc-form" onSubmit={(e: FormEvent) => (e.preventDefault(), save.mutate(form))} className="flex flex-col gap-4">
                {save.error && <Alert>{errorMessage(save.error)}</Alert>}
                <Input label="Name" required value={form.name} onChange={set('name')} />
                <Select label="Category" value={form.category} onChange={set('category')}>
                  {Object.entries(categoryLabel).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Textarea label="Description / preparation" value={form.description} onChange={set('description')} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Duration (min)" type="number" min={1} max={480} value={form.durationMinutes} onChange={set('durationMinutes')} />
                  <Input label="Price (₹, optional)" type="number" min={0} step="0.01" value={form.price} onChange={set('price')} />
                </div>
              </form>
            )}
          </Dialog>
        </div>
      )}
    </OrgPage>
  );
}

// ─── Staff ───

export function OrgStaff() {
  const qc = useQueryClient();
  const toast = useToast();
  const ctx = useManagedOrg();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: '', fullName: '', password: '', staffRole: 'RECEPTIONIST' });
  const add = useMutation({
    mutationFn: () => api.post(`/organizations/${ctx.id}/staff`, Object.fromEntries(Object.entries(f).filter(([, v]) => v))),
    onSuccess: () => {
      setOpen(false);
      setF({ email: '', fullName: '', password: '', staffRole: 'RECEPTIONIST' });
      qc.invalidateQueries({ queryKey: orgKey(ctx.id) });
    },
  });
  const remove = useMutation({
    mutationFn: (memberId: string) => api.del(`/organizations/${ctx.id}/staff/${memberId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(ctx.id) }),
    onError: (err) => toast({ tone: 'error', title: 'Could not remove', body: errorMessage(err) }),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <OrgPage>
      {(org) => (
        <div>
          <PageHeader title="Staff" subtitle="Receptionists and managers can run every queue of this organization." actions={<Button icon={<UserPlus className="size-5" />} onClick={() => setOpen(true)}>Add staff</Button>} />
          <Card>
            <Table head={['Name', 'Email', 'Role', '']}>
              {org.staff.map((m) => (
                <tr key={m.id}>
                  <Td className="font-semibold">{m.user.fullName}</Td>
                  <Td>{m.user.email}</Td>
                  <Td>
                    <Badge tone={m.staffRole === 'OWNER' ? 'brand' : 'neutral'}>{staffRoleLabel[m.staffRole]}</Badge>
                  </Td>
                  <Td className="text-right">
                    {m.staffRole !== 'OWNER' && (
                      <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)}>
                        Remove
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Dialog open={open} onClose={() => setOpen(false)} title="Add staff member" footer={<Button type="submit" form="staff-form" loading={add.isPending}>Add</Button>}>
            <form id="staff-form" onSubmit={(e: FormEvent) => (e.preventDefault(), add.mutate())} className="flex flex-col gap-4">
              {add.error && <Alert>{errorMessage(add.error)}</Alert>}
              <Input label="Email" type="email" required value={f.email} onChange={set('email')} />
              <Select label="Role" value={f.staffRole} onChange={set('staffRole')}>
                <option value="RECEPTIONIST">Receptionist — runs queues</option>
                <option value="MANAGER">Manager — also edits doctors, services and hours</option>
              </Select>
              <p className="text-sm text-ink-2">New to QFree? Also fill in:</p>
              <Input label="Full name" value={f.fullName} onChange={set('fullName')} />
              <Input label="Temporary password" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />
            </form>
          </Dialog>
        </div>
      )}
    </OrgPage>
  );
}

// ─── Operating hours ───

export function HoursEditor({ value, onChange }: { value: Hours[]; onChange: (h: Hours[]) => void }) {
  const row = (d: number): Hours => value.find((h) => h.dayOfWeek === d) ?? { dayOfWeek: d, openTime: '09:00', closeTime: '18:00', isClosed: true };
  const update = (d: number, patch: Partial<Hours>) => onChange(DAYS.map((_, i) => (i === d ? { ...row(i), ...patch } : row(i))));
  return (
    <ul className="flex flex-col divide-y divide-line">
      {DAYS.map((day, d) => {
        const h = row(d);
        return (
          <li key={day} className="flex flex-wrap items-center gap-3 py-3">
            <span className="w-28 font-medium">{day}</span>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-5 accent-[var(--brand)]" checked={!h.isClosed} onChange={(e) => update(d, { isClosed: !e.target.checked })} />
              Open
            </label>
            {!h.isClosed && (
              <span className="flex items-center gap-2">
                <input type="time" aria-label={`${day} opens`} className={inputClass} value={h.openTime} onChange={(e) => update(d, { openTime: e.target.value })} />
                <span aria-hidden>–</span>
                <input type="time" aria-label={`${day} closes`} className={inputClass} value={h.closeTime} onChange={(e) => update(d, { closeTime: e.target.value })} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function OrgHours() {
  const qc = useQueryClient();
  const toast = useToast();
  const ctx = useManagedOrg();
  const [hours, setHours] = useState<Hours[] | null>(null);
  const save = useMutation({
    mutationFn: (h: Hours[]) => api.put(`/organizations/${ctx.id}/hours`, h),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Opening hours saved' });
      qc.invalidateQueries({ queryKey: orgKey(ctx.id) });
    },
    onError: (err) => toast({ tone: 'error', title: 'Could not save', body: errorMessage(err) }),
  });
  return (
    <OrgPage>
      {(org) => {
        const current = hours ?? org.hours;
        return (
          <div>
            <PageHeader title="Operating hours" subtitle={`Local time (${org.timezone}). Queues can't be opened outside these hours without confirmation.`} actions={<Button loading={save.isPending} onClick={() => save.mutate(current)}>Save hours</Button>} />
            <Card>
              <HoursEditor value={current} onChange={setHours} />
            </Card>
          </div>
        );
      }}
    </OrgPage>
  );
}

// ─── Reports ───

function toCsv(rows: (string | number | null)[][]) {
  return rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function OrgReports() {
  const ctx = useManagedOrg();
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const report = useQuery({
    queryKey: ['org-report', ctx.id, from, to],
    queryFn: () => api.get<Analytics>(`/analytics/organizations/${ctx.id}`, { from, to, bucket: 'day' }),
    enabled: !!ctx.id,
  });
  const download = () => {
    if (!report.data) return;
    const d = report.data;
    const csv = toCsv([
      ['Queue', 'Tokens', 'Served', 'Cancelled/No-show', 'Avg wait (min)', 'Avg consult (min)'],
      ...d.perQueue.map((q) => [q.name, q.total, q.served, q.lost, q.avgWaitMinutes, q.avgConsultMinutes]),
      [],
      ['Date', 'Tokens', 'Served', 'Cancelled', 'No-show', 'Avg wait (min)'],
      ...d.volume.map((v) => [v.period, v.total, v.served, v.cancelled, v.noShow, v.avgWaitMinutes]),
    ]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `qfree-report-${from}-to-${to}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <OrgPage>
      {(org) => (
        <div>
          <PageHeader title="Reports" subtitle="Daily and monthly operational reports." actions={<Button variant="secondary" icon={<Download className="size-5" />} onClick={download} disabled={!report.data}>Download CSV</Button>} />
          <Card className="mb-5">
            <div className="flex flex-wrap gap-3">
              <Input label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              <Input label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
            {report.data && (
              <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard label="Tokens" value={report.data.summary.total} />
                <StatCard label="Served" value={report.data.summary.served} />
                <StatCard label="Avg wait" value={minutes(report.data.summary.avgWaitMinutes)} />
                <StatCard label="No-shows" value={report.data.summary.noShow} />
              </div>
            )}
            {report.data && report.data.perQueue.length > 0 && (
              <div className="mt-5">
                <Table head={['Queue', 'Tokens', 'Served', 'Lost', 'Avg wait', 'Avg consult']}>
                  {report.data.perQueue.map((q) => (
                    <tr key={q.id}>
                      <Td className="font-semibold">{q.name}</Td>
                      <Td>{q.total}</Td>
                      <Td>{q.served}</Td>
                      <Td>{q.lost}</Td>
                      <Td>{minutes(q.avgWaitMinutes)}</Td>
                      <Td>{minutes(q.avgConsultMinutes)}</Td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
          </Card>
          <h2 className="mb-3 text-xl font-semibold">Token log</h2>
          <QueueHistoryView queues={org.queues} />
        </div>
      )}
    </OrgPage>
  );
}

export function OrgAnalytics() {
  const { id } = useCurrentOrgId();
  if (!id) return <Navigate to="/org/setup" replace />;
  return (
    <div>
      <PageHeader title="Analytics" subtitle="Waiting times, volumes and peak hours across all your queues." actions={<OrgSwitcher />} />
      <AnalyticsPanel endpoint={`/analytics/organizations/${id}`} />
    </div>
  );
}

// ─── Profile & setup ───

type OrgForm = { name: string; type: OrgType; description: string; address: string; city: string; phone: string; email: string; timezone: string };

function OrgFields({ f, set }: { f: OrgForm; set: (k: keyof OrgForm) => (e: { target: { value: string } }) => void }) {
  return (
    <>
      <Input label="Name" required minLength={2} value={f.name} onChange={set('name')} />
      <Select label="Type" value={f.type} onChange={set('type')}>
        {Object.entries(orgTypeLabel).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
      <Textarea label="Description" value={f.description} onChange={set('description')} maxLength={1000} />
      <Input label="Address" required value={f.address} onChange={set('address')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="City" required value={f.city} onChange={set('city')} />
        <Input label="Time zone" required value={f.timezone} onChange={set('timezone')} hint="e.g. Asia/Kolkata" />
        <Input label="Phone" type="tel" value={f.phone} onChange={set('phone')} />
        <Input label="Public email" type="email" value={f.email} onChange={set('email')} />
      </div>
    </>
  );
}

const clean = (f: OrgForm) => ({ ...f, description: f.description || undefined, phone: f.phone || undefined, email: f.email || undefined });

export function OrgProfile() {
  const qc = useQueryClient();
  const toast = useToast();
  const { reload } = useAuth();
  const ctx = useManagedOrg();
  const [f, setF] = useState<OrgForm | null>(null);
  useEffect(() => setF(null), [ctx.id]);
  const save = useMutation({
    mutationFn: (body: OrgForm) => api.patch(`/organizations/${ctx.id}`, clean(body)),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Organization updated' });
      qc.invalidateQueries({ queryKey: orgKey(ctx.id) });
      reload();
    },
  });
  return (
    <OrgPage>
      {(org) => {
        const form = f ?? { name: org.name, type: org.type, description: org.description ?? '', address: org.address, city: org.city, phone: org.phone ?? '', email: org.email ?? '', timezone: org.timezone };
        const set = (k: keyof OrgForm) => (e: { target: { value: string } }) => setF({ ...form, [k]: e.target.value });
        return (
          <div>
            <PageHeader title="Organization profile" actions={<><OrgSwitcher /><LinkButton variant="secondary" to={`/providers/${org.id}`}>View public page</LinkButton></>} />
            <Card className="max-w-2xl">
              <form onSubmit={(e: FormEvent) => (e.preventDefault(), save.mutate(form))} className="flex flex-col gap-4">
                {save.error && <Alert>{errorMessage(save.error)}</Alert>}
                {org.isVerified ? <Badge tone="active">Verified by QFree</Badge> : <Badge tone="waiting">Awaiting verification</Badge>}
                <OrgFields f={form} set={set} />
                <Button type="submit" loading={save.isPending}>
                  Save changes
                </Button>
              </form>
            </Card>
            <div className="mt-5">
              <LinkButton to="/org/setup" variant="ghost" icon={<Plus className="size-5" />}>
                Add another branch
              </LinkButton>
            </div>
          </div>
        );
      }}
    </OrgPage>
  );
}

const defaultHours: Hours[] = DAYS.map((_, d) => ({ dayOfWeek: d, openTime: '09:00', closeTime: '18:00', isClosed: d === 0 }));

/** Create a clinic / lab (organization admins) or a doctor's own practice. */
export function OrgSetup() {
  const { user, reload } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState<OrgForm>({
    name: user?.role === 'DOCTOR' ? `${user.fullName}'s Clinic` : '',
    type: 'CLINIC',
    description: '',
    address: '',
    city: '',
    phone: '',
    email: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
  });
  const [hours, setHours] = useState(defaultHours);
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/organizations', { ...clean(f), hours }),
    onSuccess: async (org) => {
      try {
        localStorage.setItem(ORG_KEY, org.id);
      } catch {
        /* ignore */
      }
      await reload();
      navigate(user?.role === 'DOCTOR' ? '/doctor' : '/org');
    },
  });
  const set = (k: keyof OrgForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <PageHeader title={user?.role === 'DOCTOR' ? 'Set up your practice' : 'Set up your clinic or laboratory'} subtitle="Patients will see these details. You can change them any time." />
      <form onSubmit={(e: FormEvent) => (e.preventDefault(), create.mutate())} className="grid gap-5 lg:grid-cols-2">
        <Card className="flex flex-col gap-4">
          {create.error && <Alert>{errorMessage(create.error)}</Alert>}
          <OrgFields f={f} set={set} />
        </Card>
        <Card>
          <CardTitle>Opening hours</CardTitle>
          <HoursEditor value={hours} onChange={setHours} />
          <Button type="submit" size="lg" className="mt-5 w-full" loading={create.isPending}>
            Create organization
          </Button>
        </Card>
      </form>
    </div>
  );
}
