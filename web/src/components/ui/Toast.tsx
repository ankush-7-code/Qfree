import clsx from 'clsx';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Bell, CheckCircle2, X, XCircle } from 'lucide-react';

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = nextId++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === 'error' ? 7000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end">
        {toasts.map((t) => {
          const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? XCircle : Bell;
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line bg-surface p-4 shadow-lg"
            >
              <Icon
                className={clsx('mt-0.5 size-5 shrink-0', t.tone === 'success' ? 'text-st-active' : t.tone === 'error' ? 'text-st-closed' : 'text-st-approach')}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{t.title}</p>
                {t.body && <p className="text-sm text-ink-2">{t.body}</p>}
              </div>
              <button onClick={() => dismiss(t.id)} className="text-muted hover:text-ink" aria-label="Dismiss">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
