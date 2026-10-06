import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { onServerWaking } from '../../lib/api';

/** Shown while the API's free hosting wakes from sleep, with how long we've been waiting. */
export function ServerWakeBanner() {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => onServerWaking((waking) => setSince(waking ? Date.now() : null)), []);
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (since === null) return null;
  const seconds = Math.round((Date.now() - since) / 1000);

  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3">
      <div className="flex max-w-lg items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-lg">
        <Loader2 className="size-5 shrink-0 animate-spin text-brand" aria-hidden />
        <p>
          <span className="font-semibold">Waking up the QFree server…</span>{' '}
          <span className="text-ink-2">
            This can take a minute or two after a quiet period. Please keep this page open — it will continue by itself.
          </span>
          <span className="tabular ml-1 text-sm text-muted" aria-hidden>
            ({seconds}s)
          </span>
        </p>
      </div>
    </div>
  );
}
