import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { onServerWaking } from '../../lib/api';

/** Shown while the API's free hosting wakes from sleep (can take up to a minute). */
export function ServerWakeBanner() {
  const [waking, setWaking] = useState(false);
  useEffect(() => onServerWaking(setWaking), []);
  if (!waking) return null;
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3">
      <div className="flex max-w-lg items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-lg">
        <Loader2 className="size-5 shrink-0 animate-spin text-brand" aria-hidden />
        <p>
          <span className="font-semibold">Waking up the QFree server…</span>{' '}
          <span className="text-ink-2">This can take up to a minute after a quiet period. Please keep this page open.</span>
        </p>
      </div>
    </div>
  );
}
