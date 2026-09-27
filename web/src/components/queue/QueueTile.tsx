import { Link } from 'react-router';
import { ChevronRight, Clock, Users } from 'lucide-react';
import type { QueueSnapshot } from '../../lib/types';
import { minutes } from '../../lib/format';
import { QueueStatusBadge } from './Status';

/** Compact, anonymous-safe queue summary used in search results and provider pages. */
export function QueueTile({ q, to }: { q: QueueSnapshot; to?: string }) {
  return (
    <Link
      to={to ?? `/queues/${q.id}`}
      className="group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-brand"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{q.doctor?.name ?? q.service?.name ?? q.name}</p>
          <p className="text-sm text-ink-2">{q.doctor ? q.doctor.specialization : q.name}</p>
        </div>
        <ChevronRight className="size-5 shrink-0 text-muted group-hover:text-brand" aria-hidden />
      </div>
      <QueueStatusBadge snapshot={q} />
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-surface-2 p-2">
          <dt className="text-xs text-muted">Now serving</dt>
          <dd className="tabular font-bold">{q.currentToken ?? '—'}</dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-2">
          <dt className="flex items-center justify-center gap-1 text-xs text-muted">
            <Users className="size-3" aria-hidden /> Waiting
          </dt>
          <dd className="tabular font-bold">{q.waitingCount}</dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-2">
          <dt className="flex items-center justify-center gap-1 text-xs text-muted">
            <Clock className="size-3" aria-hidden /> Wait
          </dt>
          <dd className="tabular font-bold">{q.status === 'CLOSED' ? '—' : minutes(q.estimatedWaitMinutes)}</dd>
        </div>
      </dl>
    </Link>
  );
}
