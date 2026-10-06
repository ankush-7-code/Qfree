import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, Clock, LogIn, Ticket, Users } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { EntryView } from '../../lib/types';
import { minutes, time } from '../../lib/format';
import { queueKey, useQueueLive } from '../../hooks/useLive';
import { Button, LinkButton } from '../../components/ui/Button';
import { Alert, Card, ErrorState, Spinner } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toast';
import { LiveQueueCard, ProviderHeading } from '../../components/queue/LiveQueueCard';
import { QueueStatusBadge } from '../../components/queue/Status';
import { BookingPanel } from '../../components/queue/BookingPanel';

function NotificationPermission() {
  const [state, setState] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  if (state !== 'default') return null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-center gap-2">
        <BellRing className="size-5 text-brand" aria-hidden />
        Get an alert on this device when your turn is near.
      </p>
      <Button variant="secondary" onClick={() => Notification.requestPermission().then(setState)}>
        Turn on alerts
      </Button>
    </Card>
  );
}

/** "Join Queue" + "Live Queue Status": public queue view that becomes the patient's live card after joining. */
export function QueuePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQueueLive(id);

  const join = useMutation({
    mutationFn: () => api.post<EntryView>(`/queues/${id}/join`),
    onSuccess: (entry) => {
      qc.setQueryData(queueKey(id!), (old: typeof data) => (old ? { ...old, myEntry: entry } : old));
      qc.invalidateQueries({ queryKey: ['patient'] });
    },
  });
  const leave = useMutation({
    mutationFn: () => api.del(`/queues/${id}/leave`),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ['patient'] });
      toast({ tone: 'info', title: 'You have left the queue' });
    },
    onError: (err) => toast({ tone: 'error', title: 'Could not leave the queue', body: errorMessage(err) }),
  });

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} retry={refetch} />;

  const { snapshot, myEntry } = data;
  const active = myEntry && (myEntry.entry.status === 'WAITING' || myEntry.entry.status === 'SERVING');

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-8">
      {myEntry && (active || myEntry.phase === 'DONE' || myEntry.phase === 'SKIPPED') ? (
        <>
          <LiveQueueCard snapshot={snapshot} myEntry={myEntry} onLeave={() => leave.mutate()} leaving={leave.isPending} />
          {myEntry.phase === 'SKIPPED' && (
            <Alert tone="waiting">
              You were not present when called. The doctor may call you again after the current queue — please stay nearby or speak to the reception desk.
            </Alert>
          )}
          {active && <NotificationPermission />}
        </>
      ) : (
        <Card className="p-6">
          <ProviderHeading snapshot={snapshot} />
          <div className="mt-4">
            <QueueStatusBadge snapshot={snapshot} size="lg" />
          </div>
          <dl className="mt-5 grid grid-cols-3 gap-3 text-center" aria-live="polite">
            <div className="rounded-2xl bg-surface-2 p-3">
              <dt className="flex items-center justify-center gap-1 text-sm text-ink-2">
                <Ticket className="size-4" aria-hidden /> Now serving
              </dt>
              <dd className="tabular whitespace-nowrap text-xl font-bold sm:text-2xl">{snapshot.currentToken ?? '—'}</dd>
            </div>
            <div className="rounded-2xl bg-surface-2 p-3">
              <dt className="flex items-center justify-center gap-1 text-sm text-ink-2">
                <Users className="size-4" aria-hidden /> Waiting
              </dt>
              <dd className="tabular text-2xl font-bold">{snapshot.waitingCount}</dd>
            </div>
            <div className="rounded-2xl bg-surface-2 p-3">
              <dt className="flex items-center justify-center gap-1 text-sm text-ink-2">
                <Clock className="size-4" aria-hidden /> Wait if you join
              </dt>
              <dd className="tabular text-2xl font-bold">{snapshot.status === 'CLOSED' ? '—' : minutes(snapshot.estimatedWaitMinutes)}</dd>
            </div>
          </dl>

          <div className="mt-6">
            {join.error && (
              <div className="mb-3">
                <Alert>{errorMessage(join.error)}</Alert>
              </div>
            )}
            {!snapshot.isAcceptingPatients ? (
              <Alert tone="waiting">
                {snapshot.joinBlockMessage ?? 'The queue is not accepting new patients at the moment.'}
                {snapshot.advanceBookingDays > 0 && (
                  <>
                    {' '}
                    <a href="#book" className="font-semibold underline">
                      Book a later day
                    </a>
                  </>
                )}
              </Alert>
            ) : !user ? (
              <LinkButton to={`/login?next=${encodeURIComponent(location.pathname)}`} size="xl" className="w-full" icon={<LogIn className="size-6" />}>
                Sign in to join
              </LinkButton>
            ) : user.role === 'PATIENT' ? (
              <Button size="xl" className="w-full" loading={join.isPending} onClick={() => join.mutate()} icon={<Ticket className="size-6" />}>
                Join queue
              </Button>
            ) : (
              <p className="text-center text-ink-2">Only patient accounts can join queues.</p>
            )}
            {snapshot.isAcceptingPatients && (
              <p className="mt-3 text-center text-sm text-muted">
                {snapshot.remainingCapacity} places left today · average {snapshot.avgServiceMinutes} min per patient
                {snapshot.status === 'PAUSED' && ' · paused briefly, you can still join'}
              </p>
            )}
          </div>
          {myEntry?.phase === 'CANCELLED' && <p className="mt-4 text-center text-ink-2">You left this queue at {time(myEntry.entry.cancelledAt)}.</p>}
        </Card>
      )}
      <BookingPanel queueId={snapshot.id} />
      <p className="text-center text-sm text-muted">
        <Link to={`/providers/${snapshot.organization.id}`} className="hover:text-brand hover:underline">
          More about {snapshot.organization.name}
        </Link>
      </p>
    </div>
  );
}
