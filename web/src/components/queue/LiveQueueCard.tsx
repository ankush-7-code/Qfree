import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BellRing, LogOut, MapPin, Stethoscope, TestTube2, WifiOff } from 'lucide-react';
import type { EntryView, QueueSnapshot } from '../../lib/types';
import { minutes, time } from '../../lib/format';
import { useSocketConnected } from '../../hooks/useLive';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { PhaseBadge, ProgressBar, QueueStatusBadge } from './Status';

function Row({ label, value, strong, sub }: { label: string; value: string | number; strong?: boolean; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-3 last:border-0">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-right">
        <span className={clsx('tabular font-bold', strong ? 'text-3xl text-brand' : 'text-2xl')}>{value}</span>
        {sub && <span className="block text-sm text-muted">{sub}</span>}
      </dd>
    </div>
  );
}

export function ProviderHeading({ snapshot }: { snapshot: QueueSnapshot }) {
  const Icon = snapshot.doctor ? Stethoscope : TestTube2;
  return (
    <div className="flex items-start gap-3">
      <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-strong">
        <Icon className="size-6" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold leading-tight">{snapshot.doctor?.name ?? snapshot.service?.name ?? snapshot.name}</p>
        <p className="text-ink-2">{snapshot.doctor?.specialization ?? snapshot.name}</p>
        <p className="flex items-center gap-1 text-sm text-muted">
          <MapPin className="size-3.5" aria-hidden />
          {snapshot.organization.name}, {snapshot.organization.city}
        </p>
      </div>
    </div>
  );
}

/**
 * The patient's live queue panel. Designed to be understood in a few seconds:
 * two big tokens, people ahead, minutes to wait, one progress bar, one status line.
 */
export function LiveQueueCard({ snapshot, myEntry, onLeave, leaving, compact }: {
  snapshot: QueueSnapshot;
  myEntry: EntryView;
  onLeave?: () => void;
  leaving?: boolean;
  compact?: boolean;
}) {
  const connected = useSocketConnected();
  const [confirm, setConfirm] = useState(false);
  const prevPhase = useRef(myEntry.phase);
  const [flash, setFlash] = useState(false);

  // Draw attention when the patient's turn gets close: flash the card and vibrate the phone.
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = myEntry.phase;
    const urgent = myEntry.phase === 'YOUR_TURN' || myEntry.phase === 'NEXT' || myEntry.phase === 'APPROACHING';
    if (urgent && was !== myEntry.phase) {
      setFlash(true);
      navigator.vibrate?.(myEntry.phase === 'YOUR_TURN' ? [300, 150, 300, 150, 300] : [200]);
      const t = setTimeout(() => setFlash(false), 3600);
      return () => clearTimeout(t);
    }
  }, [myEntry.phase]);

  const waiting = myEntry.entry.status === 'WAITING';
  const yourTurn = myEntry.phase === 'YOUR_TURN';

  return (
    <article
      aria-labelledby={`live-${snapshot.id}`}
      className={clsx('overflow-hidden rounded-3xl border-2 bg-surface shadow-sm', yourTurn ? 'border-st-active' : 'border-line', flash && 'flash')}
    >
      <header className="flex items-center justify-between gap-2 bg-brand px-5 py-3 text-on-brand">
        <h2 id={`live-${snapshot.id}`} className="font-semibold">
          QFree — Live Queue
        </h2>
        <span className="flex items-center gap-1.5 text-sm" aria-live="polite">
          {connected ? (
            <>
              <span className="live-dot size-2 rounded-full bg-current" aria-hidden /> Live
            </>
          ) : (
            <>
              <WifiOff className="size-4" aria-hidden /> Reconnecting…
            </>
          )}
        </span>
      </header>

      <div className="p-5">
        <ProviderHeading snapshot={snapshot} />

        {yourTurn && (
          <div role="alert" className="mt-4 flex items-center gap-3 rounded-2xl bg-st-active px-4 py-4 text-white">
            <BellRing className="size-8 shrink-0" aria-hidden />
            <div>
              <p className="text-xl font-bold">{myEntry.entry.recalledAt ? "You're being called again!" : "It's your turn!"}</p>
              <p>Please go to {snapshot.doctor?.name ?? snapshot.name} now.</p>
            </div>
          </div>
        )}

        <dl className="mt-4" aria-live="polite">
          <Row label="Current token" value={snapshot.currentToken ?? '—'} />
          <Row label="Your token" value={myEntry.entry.tokenLabel} strong />
          {waiting && <Row label="Patients ahead" value={myEntry.patientsAhead} />}
          {waiting && (
            <Row
              label="Estimated wait"
              value={minutes(myEntry.estimatedWaitMinutes)}
              sub={myEntry.expectedAt ? `around ${time(myEntry.expectedAt)}` : undefined}
            />
          )}
        </dl>

        {waiting && (
          <div className="mt-4">
            <ProgressBar value={myEntry.progress} label={`Queue progress: ${myEntry.patientsAhead} patients ahead of you`} />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <QueueStatusBadge snapshot={snapshot} size={compact ? 'md' : 'lg'} />
          <PhaseBadge phase={myEntry.phase} size={compact ? 'md' : 'lg'} />
        </div>
        {snapshot.status === 'PAUSED' && waiting && (
          <p className="mt-3 text-center text-ink-2">The doctor has paused the queue briefly. Your place is safe.</p>
        )}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {compact && (
            <Link to={`/queues/${snapshot.id}`} className="min-h-11 rounded-xl px-4 py-2.5 font-semibold text-brand hover:bg-brand-soft">
              Open full view
            </Link>
          )}
          {waiting && onLeave && (
            <Button variant="secondary" icon={<LogOut className="size-5" />} onClick={() => setConfirm(true)}>
              Leave queue
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Leave this queue?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Stay in queue
            </Button>
            <Button
              variant="danger"
              loading={leaving}
              onClick={() => {
                onLeave?.();
                setConfirm(false);
              }}
            >
              Yes, leave
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          You will lose token <strong className="text-ink">{myEntry.entry.tokenLabel}</strong>. If you join again you will get a new token at the end of the line.
        </p>
      </Dialog>
    </article>
  );
}
