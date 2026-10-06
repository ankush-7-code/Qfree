import clsx from 'clsx';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, Check, ChevronRight, DoorClosed, DoorOpen, Megaphone, Pause, Play, Power, Undo2, UserPlus, UserX, X } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import type { Priority, StaffEntry, StaffView } from '../../lib/types';
import { clock, dayLabel, minutes, priorityLabel, sourceLabel, time } from '../../lib/format';
import { staffKey, useStaffQueue } from '../../hooks/useLive';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Badge, Card, CardTitle, EmptyState, ErrorState, Input, Select, Spinner, StatCard, Textarea } from '../ui/primitives';
import { useToast } from '../ui/Toast';
import { EntryStatusBadge, QueueStatusBadge } from './Status';

function useElapsed(since: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - new Date(since).getTime()) / 60000)) : 0;
}

const who = (e: StaffEntry) =>
  [e.patient.age !== null ? `${e.patient.age} y` : null, e.patient.gender ? e.patient.gender.charAt(0) + e.patient.gender.slice(1).toLowerCase() : null]
    .filter(Boolean)
    .join(' · ');

function PriorityBadge({ p }: { p: Priority }) {
  if (p === 'NORMAL') return null;
  return (
    <Badge tone={p === 'EMERGENCY' ? 'closed' : 'approach'}>
      {p === 'EMERGENCY' && <AlertTriangle className="size-3.5" aria-hidden />}
      {priorityLabel[p]}
    </Badge>
  );
}

function SourceBadge({ e }: { e: StaffEntry }) {
  if (e.source === 'SAME_DAY') return null;
  if (e.source === 'ADVANCE' && e.appointmentTime) return <Badge tone="approach">Booked · {clock(e.appointmentTime)}</Badge>;
  return <Badge tone={e.source === 'ADVANCE' ? 'approach' : 'neutral'}>{sourceLabel[e.source]}</Badge>;
}

type DialogState =
  | { kind: 'priority'; entry: StaffEntry }
  | { kind: 'cancel'; entry: StaffEntry }
  | { kind: 'recall'; entry: StaffEntry }
  | { kind: 'walk-in' }
  | { kind: 'close' }
  | { kind: 'outside-hours' }
  | null;

/** Whether new patients can join today, and the rules that decide it. */
function IntakeBar({ view, busy, run, onAddPatient }: { view: StaffView; busy: boolean; run: (path: string, body?: unknown) => void; onAddPatient: () => void }) {
  const s = view.snapshot;
  if (s.status === 'CLOSED') return null;
  const rules = [
    `max ${s.closingRules.capacity} patients/day`,
    s.closingRules.cutoffTime ? `new patients until ${clock(s.closingRules.cutoffTime)}` : null,
    s.allowSameDayJoin ? 'online same-day joining on' : 'online same-day joining off',
    s.advanceBookingDays ? `booking up to ${s.advanceBookingDays} day${s.advanceBookingDays === 1 ? '' : 's'} ahead` : 'no advance booking',
  ].filter(Boolean);
  const stoppedByDoctor = s.closingRules.joinsStopped;
  const blockedByRule = !s.isAcceptingPatients && (s.joinBlock === 'FULL' || s.joinBlock === 'CUTOFF_PASSED');

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className={clsx('flex items-center gap-2 font-semibold', s.isAcceptingPatients ? 'text-st-active' : 'text-st-paused')} aria-live="polite">
          {s.isAcceptingPatients ? <DoorOpen className="size-5" aria-hidden /> : <DoorClosed className="size-5" aria-hidden />}
          {s.isAcceptingPatients ? 'Accepting new patients' : `Not accepting new patients — ${s.joinBlockMessage}`}
        </p>
        <p className="text-sm text-ink-2">
          {view.stats.total} of {s.closingRules.capacity} places used today · {rules.join(' · ')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<UserPlus className="size-5" />} onClick={onAddPatient} disabled={busy}>
          Add patient (on the spot)
        </Button>
        {stoppedByDoctor || s.joinBlock === 'CUTOFF_PASSED' ? (
          <Button icon={<DoorOpen className="size-5" />} onClick={() => run('joins/reopen')} disabled={busy}>
            Reopen for new patients
          </Button>
        ) : (
          !blockedByRule && (
            <Button variant="secondary" icon={<DoorClosed className="size-5" />} onClick={() => run('joins/stop')} disabled={busy}>
              Stop new patients
            </Button>
          )
        )}
      </div>
    </Card>
  );
}

function UpcomingBookings({ queueId, days }: { queueId: string; days: number }) {
  const { data } = useQuery({
    queryKey: ['queue', queueId, 'bookings'],
    queryFn: () => api.get<{ days: { date: string; bookings: { id: string; tokenLabel: string; appointmentTime: string | null; patient: { name: string; phone: string | null } }[] }[] }>(`/queues/${queueId}/bookings`),
    enabled: days > 0,
  });
  if (!days || !data) return null;
  const total = data.days.reduce((n, d) => n + d.bookings.length, 0);
  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer items-center gap-2 text-lg font-semibold">
          <CalendarDays className="size-5 text-brand" aria-hidden /> Upcoming bookings ({total})
        </summary>
        {total === 0 ? (
          <p className="mt-3 text-ink-2">No advance bookings yet. Patients can book up to {days} days ahead.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {data.days.map((d) => (
              <div key={d.date}>
                <p className="font-semibold">
                  {dayLabel(d.date)} · {d.bookings.length} booked
                </p>
                <ul className="mt-1 flex flex-col divide-y divide-line">
                  {d.bookings.map((b) => (
                    <li key={b.id} className="flex flex-wrap gap-3 py-1.5">
                      <span className="tabular min-w-20 font-semibold">{b.appointmentTime ? clock(b.appointmentTime) : '—'}</span>
                      <span className="tabular min-w-20 font-semibold">{b.tokenLabel}</span>
                      <span className="flex-1">{b.patient.name}</span>
                      {b.patient.phone && <span className="text-sm text-muted">{b.patient.phone}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </details>
    </Card>
  );
}

/** Live operational board for one queue. `detailsBase` builds links to patient details. */
export function QueueBoard({ queueId, detailsBase }: { queueId: string; detailsBase: string }) {
  const { data, isLoading, error, refetch } = useStaffQueue(queueId);
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [priority, setPriority] = useState<Priority>('PRIORITY');
  const [reason, setReason] = useState('');
  const [walkIn, setWalkIn] = useState({ fullName: '', phone: '', overLimit: false, limitHit: false });
  const elapsed = useElapsed(data?.serving?.calledAt ?? null);

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<Record<string, unknown>>(`/queues/${queueId}/${path}`, body),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: staffKey(queueId) });
      if (vars.path === 'next') {
        const later = res.nextAppointment as { token: string; time: string } | undefined;
        toast(
          res.called
            ? { tone: 'success', title: `Now calling ${res.called}` }
            : later
              ? { tone: 'info', title: `Next patient is booked for ${clock(later.time)}`, body: `${later.token} isn't due yet. Use “Call now” to call them early.` }
              : { tone: 'info', title: 'No one is waiting' },
        );
      }
      if (vars.path.endsWith('/recall')) toast({ tone: 'success', title: `Recalling ${res.recalled}` });
      if (vars.path === 'walk-ins') {
        toast({ tone: 'success', title: `Token ${res.tokenLabel} added`, body: `Please give the patient token ${res.tokenLabel}.` });
        setWalkIn({ fullName: '', phone: '', overLimit: false, limitHit: false });
      }
      setDialog(null);
      setReason('');
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.code === 'OUTSIDE_HOURS' && vars.path === 'open') return setDialog({ kind: 'outside-hours' });
      if (err instanceof ApiError && err.code === 'QUEUE_FULL' && vars.path === 'walk-ins') return setWalkIn((w) => ({ ...w, limitHit: true }));
      toast({ tone: 'error', title: 'Action failed', body: errorMessage(err) });
    },
  });
  const run = (path: string, body?: unknown) => action.mutate({ path, body });
  const busy = action.isPending;

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;

  const { snapshot, serving, waiting, missed, finished, stats } = data;
  const status = snapshot.status;
  const recall = (e: StaffEntry) => (waiting.length ? setDialog({ kind: 'recall', entry: e }) : run(`entries/${e.id}/recall`));
  const submitWalkIn = (e: FormEvent) => {
    e.preventDefault();
    run('walk-ins', { fullName: walkIn.fullName, phone: walkIn.phone || undefined, overrideLimit: walkIn.overLimit || undefined });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Queue controls */}
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <QueueStatusBadge snapshot={snapshot} size="lg" />
          <span className="text-ink-2">
            {snapshot.sessionDate ? `Session ${snapshot.sessionDate}` : 'No session yet'} · avg {snapshot.avgServiceMinutes} min per patient
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {status === 'CLOSED' && (
            <Button icon={<Power className="size-5" />} onClick={() => run('open', {})} loading={busy}>
              {snapshot.sessionDate ? 'Open / reopen queue' : 'Open queue'}
            </Button>
          )}
          {status === 'OPEN' && (
            <Button variant="secondary" icon={<Pause className="size-5" />} onClick={() => run('pause')} disabled={busy}>
              Pause
            </Button>
          )}
          {status === 'PAUSED' && (
            <Button icon={<Play className="size-5" />} onClick={() => run('resume')} disabled={busy}>
              Resume
            </Button>
          )}
          {status !== 'CLOSED' && (
            <Button variant="secondary" icon={<Power className="size-5" />} onClick={() => setDialog({ kind: 'close' })} disabled={busy}>
              Close for today
            </Button>
          )}
        </div>
      </Card>

      <IntakeBar view={data} busy={busy} run={run} onAddPatient={() => setDialog({ kind: 'walk-in' })} />

      {/* Serving */}
      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <Card className={clsx('flex flex-col gap-4', serving && 'border-st-active')}>
          <CardTitle>Now serving</CardTitle>
          {serving ? (
            <div className="flex flex-wrap items-center gap-5">
              <div className="rounded-2xl bg-st-active-soft px-6 py-4 text-center text-st-active">
                <p className="text-sm font-medium">Token</p>
                <p className="tabular text-5xl font-extrabold">{serving.tokenLabel}</p>
              </div>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                  {serving.patient.name} <EntryStatusBadge status={serving.status} recalledAt={serving.recalledAt} />
                </p>
                <p className="text-ink-2">{who(serving)}</p>
                <p className="text-sm text-muted">
                  Called {time(serving.calledAt)} · {elapsed} min ago
                </p>
                <Link to={`${detailsBase}/${serving.id}`} className="text-sm font-semibold text-brand hover:underline">
                  Patient details
                </Link>
              </div>
            </div>
          ) : (
            <p className="text-ink-2">{waiting.length ? 'No one is with the doctor. Call the next patient when ready.' : 'No patients waiting right now.'}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="xl" icon={<Megaphone className="size-6" />} onClick={() => run('next')} loading={busy} disabled={status !== 'OPEN' || (!waiting.length && !serving)} className="grow sm:grow-0">
              {serving ? 'Done · call next' : 'Call next patient'}
            </Button>
            {serving && (
              <>
                <Button variant="secondary" size="lg" icon={<Check className="size-5" />} onClick={() => run('complete')} disabled={busy}>
                  Mark served
                </Button>
                <Button variant="secondary" size="lg" icon={<UserX className="size-5" />} onClick={() => run(`entries/${serving.id}/skip`, { reason: 'Not present when called' })} disabled={busy}>
                  Not present
                </Button>
              </>
            )}
          </div>
          {status === 'PAUSED' && <p className="text-st-paused">Queue is paused — resume it to call patients.</p>}
          {waiting[0] && (
            <p className="text-ink-2">
              Up next: <strong className="text-ink">{waiting[0].tokenLabel}</strong> · {waiting[0].patient.name}
            </p>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Waiting" value={stats.waiting} />
          <StatCard label="Served today" value={stats.served} />
          <StatCard label="Avg wait" value={minutes(stats.avgWaitMinutes)} />
          <StatCard label="Avg consult" value={minutes(stats.avgConsultMinutes)} />
          <StatCard label="Missed" value={stats.missed} hint={stats.recalled ? `${stats.recalled} recalled` : undefined} />
          <StatCard label="Cancelled / no-show" value={stats.cancelled + stats.noShow} />
        </div>
      </div>

      {/* Missed — highlighted once the active queue is done */}
      {missed.length > 0 && (
        <Card className={clsx(!waiting.length && 'border-st-approach')}>
          <CardTitle>Missed — not present when called ({missed.length})</CardTitle>
          {waiting.length === 0 ? (
            <Alert tone="approach">The active queue is complete. You can now recall missed patients.</Alert>
          ) : (
            <p className="-mt-2 mb-2 text-sm text-ink-2">
              These patients are kept out of the line so it isn't disturbed. Recall them when you decide, usually after the {waiting.length} waiting patient{waiting.length === 1 ? '' : 's'}.
            </p>
          )}
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {missed.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="tabular min-w-20 text-lg font-bold">{e.tokenLabel}</span>
                <span className="flex-1">
                  {e.patient.name}
                  <span className="block text-sm text-muted">Missed at {time(e.calledAt)}</span>
                </span>
                <Button size="sm" variant={waiting.length ? 'secondary' : 'primary'} icon={<Undo2 className="size-4" />} onClick={() => recall(e)} disabled={busy || status !== 'OPEN'}>
                  Recall
                </Button>
                <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => run(`entries/${e.id}/no-show`)} disabled={busy}>
                  No-show
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Waiting */}
      <Card>
        <CardTitle>
          Waiting patients <span className="text-muted">({waiting.length})</span>
        </CardTitle>
        {waiting.length === 0 ? (
          <EmptyState title="The waiting list is empty">Patients who join, booked patients and patients added at reception appear here instantly.</EmptyState>
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {waiting.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="tabular w-8 text-center text-lg font-bold text-muted">{e.position}</span>
                <span className="tabular min-w-20 text-lg font-bold">{e.tokenLabel}</span>
                <div className="min-w-40 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {e.patient.name} <PriorityBadge p={e.priority} /> <SourceBadge e={e} />
                  </p>
                  <p className="text-sm text-muted">
                    {who(e)} {who(e) && '·'} {e.source === 'ADVANCE' ? 'booked' : 'joined'} {time(e.joinedAt)} · ~{minutes(e.estimatedWaitMinutes)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => run(`entries/${e.id}/call`)} disabled={busy || status !== 'OPEN'}>
                    Call now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (setPriority(e.priority === 'NORMAL' ? 'PRIORITY' : e.priority), setDialog({ kind: 'priority', entry: e }))}>
                    Priority
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => run(`entries/${e.id}/skip`, {})} disabled={busy}>
                    Missed
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'cancel', entry: e })}>
                    Cancel
                  </Button>
                  <Link to={`${detailsBase}/${e.id}`} className="inline-flex min-h-9 items-center rounded-xl px-2 text-muted hover:bg-surface-2" aria-label={`Details for ${e.tokenLabel}`}>
                    <ChevronRight className="size-5" />
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <UpcomingBookings queueId={queueId} days={snapshot.advanceBookingDays} />

      {/* Finished */}
      {finished.length > 0 && (
        <Card>
          <details>
            <summary className="cursor-pointer text-lg font-semibold">Finished today ({finished.length})</summary>
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {finished.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="tabular min-w-20 font-semibold">{e.tokenLabel}</span>
                  <span className="flex-1">{e.patient.name}</span>
                  {e.recalledAt && <Badge tone="approach">Recalled</Badge>}
                  <EntryStatusBadge status={e.status} />
                  <span className="text-sm text-muted">{time(e.completedAt ?? e.cancelledAt ?? e.calledAt)}</span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      )}

      {/* Dialogs */}
      <Dialog
        open={dialog?.kind === 'walk-in'}
        onClose={() => (setDialog(null), setWalkIn((w) => ({ ...w, overLimit: false, limitHit: false })))}
        title="Add a patient on the spot"
        footer={
          <Button type="submit" form="walk-in-form" loading={busy} disabled={walkIn.fullName.trim().length < 2 || (walkIn.limitHit && !walkIn.overLimit)}>
            Add and issue token
          </Button>
        }
      >
        <form id="walk-in-form" onSubmit={submitWalkIn} className="flex flex-col gap-4">
          <p className="text-ink-2">For patients who are here in person — for example without a smartphone. They join at the end of today's line.</p>
          <Input label="Patient name" required minLength={2} maxLength={100} value={walkIn.fullName} onChange={(e) => setWalkIn({ ...walkIn, fullName: e.target.value })} />
          <Input label="Mobile number (optional)" type="tel" value={walkIn.phone} onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })} />
          {walkIn.limitHit && (
            <Alert tone="waiting">
              Today's limit of {snapshot.capacity} patients has been reached.
              <label className="mt-2 flex items-center gap-2 font-medium">
                <input type="checkbox" className="size-5 accent-[var(--brand)]" checked={walkIn.overLimit} onChange={(e) => setWalkIn({ ...walkIn, overLimit: e.target.checked })} />
                Add over the limit (doctor approved — recorded in the audit log)
              </label>
            </Alert>
          )}
        </form>
      </Dialog>

      <Dialog
        open={dialog?.kind === 'recall'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'recall' ? `Recall ${dialog.entry.tokenLabel} now?` : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Wait for the queue
            </Button>
            <Button loading={busy} onClick={() => dialog?.kind === 'recall' && run(`entries/${dialog.entry.id}/recall`)}>
              Recall now
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          {waiting.length} patient{waiting.length === 1 ? ' is' : 's are'} still waiting in line. Recalling now calls this patient ahead of them.
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === 'priority'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'priority' ? `Priority for ${dialog.entry.tokenLabel}` : ''}
        footer={
          <Button loading={busy} disabled={reason.trim().length < 3} onClick={() => dialog?.kind === 'priority' && run(`entries/${dialog.entry.id}/priority`, { priority, reason })}>
            Save priority
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            <option value="NORMAL">Normal</option>
            <option value="PRIORITY">Priority — elderly, pregnant, disabled</option>
            <option value="EMERGENCY">Emergency — serve next</option>
          </Select>
          <Textarea label="Reason (required, recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === 'cancel'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'cancel' ? `Cancel ${dialog.entry.tokenLabel}?` : ''}
        footer={
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => dialog?.kind === 'cancel' && run(`entries/${dialog.entry.id}/cancel`, { reason })}>
            Cancel entry
          </Button>
        }
      >
        <Textarea label="Reason shown to the patient" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </Dialog>

      <Dialog
        open={dialog?.kind === 'close'}
        onClose={() => setDialog(null)}
        title="Close the queue for today?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Keep open
            </Button>
            <Button variant="danger" loading={busy} onClick={() => run('close')}>
              Close queue
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          {waiting.length} waiting patient{waiting.length === 1 ? '' : 's'} will be cancelled and notified. Missed patients are recorded as no-shows. To only stop new patients while
          finishing the current line, use “Stop new patients” instead. You can reopen the queue later today.
        </p>
      </Dialog>

      <Dialog
        open={dialog?.kind === 'outside-hours'}
        onClose={() => setDialog(null)}
        title="Outside operating hours"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Not now
            </Button>
            <Button loading={busy} onClick={() => run('open', { override: true })}>
              Open anyway
            </Button>
          </>
        }
      >
        <p className="text-ink-2">The organization is closed at this time according to its opening hours. Opening anyway is recorded in the audit log.</p>
      </Dialog>
    </div>
  );
}
