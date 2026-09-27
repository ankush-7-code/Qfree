import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronRight, Megaphone, Pause, Play, Power, RotateCcw, UserX, X } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import type { Priority, StaffEntry } from '../../lib/types';
import { minutes, priorityLabel, time } from '../../lib/format';
import { staffKey, useStaffQueue } from '../../hooks/useLive';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Badge, Card, CardTitle, EmptyState, ErrorState, Select, Spinner, StatCard, Textarea } from '../ui/primitives';
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

type DialogState =
  | { kind: 'priority'; entry: StaffEntry }
  | { kind: 'cancel'; entry: StaffEntry }
  | { kind: 'close' }
  | { kind: 'outside-hours' }
  | null;

/** Live operational board for one queue. `detailsBase` builds links to patient details. */
export function QueueBoard({ queueId, detailsBase }: { queueId: string; detailsBase: string }) {
  const { data, isLoading, error, refetch } = useStaffQueue(queueId);
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [priority, setPriority] = useState<Priority>('PRIORITY');
  const [reason, setReason] = useState('');
  const elapsed = useElapsed(data?.serving?.calledAt ?? null);

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<Record<string, unknown>>(`/queues/${queueId}/${path}`, body),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: staffKey(queueId) });
      if (vars.path === 'next') {
        toast(res.called ? { tone: 'success', title: `Now calling ${res.called}` } : { tone: 'info', title: 'No one is waiting' });
      }
      setDialog(null);
      setReason('');
    },
    onError: (err, vars) => {
      if (err instanceof ApiError && err.code === 'OUTSIDE_HOURS' && vars.path === 'open') return setDialog({ kind: 'outside-hours' });
      toast({ tone: 'error', title: 'Action failed', body: errorMessage(err) });
    },
  });
  const run = (path: string, body?: unknown) => action.mutate({ path, body });
  const busy = action.isPending;

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;

  const { snapshot, serving, waiting, skipped, finished, stats } = data;
  const status = snapshot.status;

  return (
    <div className="flex flex-col gap-5">
      {/* Controls */}
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <QueueStatusBadge snapshot={snapshot} size="lg" />
          <span className="text-ink-2">
            {snapshot.sessionDate ? `Session ${snapshot.sessionDate}` : 'No session yet'} · capacity {snapshot.capacity} · avg {snapshot.avgServiceMinutes} min
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {status === 'CLOSED' && (
            <Button icon={<Power className="size-5" />} onClick={() => run('open', {})} loading={busy}>
              Open queue
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
                <p className="text-xl font-semibold">{serving.patient.name}</p>
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
          <StatCard label="Skipped" value={stats.skipped} />
          <StatCard label="Cancelled / no-show" value={stats.cancelled + stats.noShow} />
        </div>
      </div>

      {/* Waiting */}
      <Card>
        <CardTitle>
          Waiting patients <span className="text-muted">({waiting.length})</span>
        </CardTitle>
        {waiting.length === 0 ? (
          <EmptyState title="The waiting list is empty">Patients who join appear here instantly.</EmptyState>
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {waiting.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="tabular w-8 text-center text-lg font-bold text-muted">{e.position}</span>
                <span className="tabular min-w-20 text-lg font-bold">{e.tokenLabel}</span>
                <div className="min-w-40 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {e.patient.name} <PriorityBadge p={e.priority} />
                    {e.skipCount > 0 && <Badge tone="paused">Re-queued</Badge>}
                  </p>
                  <p className="text-sm text-muted">
                    {who(e)} {who(e) && '·'} joined {time(e.joinedAt)} · ~{minutes(e.estimatedWaitMinutes)}
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
                    Skip
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

      {/* Skipped */}
      {skipped.length > 0 && (
        <Card>
          <CardTitle>Skipped — not present when called</CardTitle>
          <ul className="flex flex-col divide-y divide-line">
            {skipped.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="tabular min-w-20 text-lg font-bold">{e.tokenLabel}</span>
                <span className="flex-1">{e.patient.name}</span>
                <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => run(`entries/${e.id}/requeue`)} disabled={busy}>
                  Patient arrived — re-queue
                </Button>
                <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => run(`entries/${e.id}/no-show`)} disabled={busy}>
                  No-show
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
        open={dialog?.kind === 'priority'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'priority' ? `Priority for ${dialog.entry.tokenLabel}` : ''}
        footer={
          <Button
            loading={busy}
            disabled={reason.trim().length < 3}
            onClick={() => dialog?.kind === 'priority' && run(`entries/${dialog.entry.id}/priority`, { priority, reason })}
          >
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
          {waiting.length} waiting patient{waiting.length === 1 ? '' : 's'} will be cancelled and notified. Skipped patients are recorded as no-shows.
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
