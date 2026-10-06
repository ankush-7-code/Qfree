import clsx from 'clsx';
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Inbox, Loader2 } from 'lucide-react';

export function Card({ className, children, as: As = 'section', id }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article'; id?: string }) {
  return (
    <As id={id} className={clsx('scroll-mt-20 rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]', className)}>
      {children}
    </As>
  );
}

export function CardTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-4 flex flex-wrap items-center justify-between gap-2', className)}>
      <h2 className="text-lg font-semibold">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

type Tone = 'neutral' | 'brand' | 'active' | 'waiting' | 'approach' | 'closed' | 'paused';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  brand: 'bg-brand-soft text-brand-strong',
  active: 'bg-st-active-soft text-st-active',
  waiting: 'bg-st-waiting-soft text-st-waiting',
  approach: 'bg-st-approach-soft text-st-approach',
  closed: 'bg-st-closed-soft text-st-closed',
  paused: 'bg-st-paused-soft text-st-paused',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={clsx('flex items-center justify-center gap-3 py-12 text-muted', className)}>
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <div className="mb-1 text-muted">{icon ?? <Inbox className="size-10" aria-hidden />}</div>
      <p className="text-lg font-semibold">{title}</p>
      {children && <div className="max-w-md text-ink-2">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'closed', children }: { tone?: 'closed' | 'approach' | 'waiting' | 'active'; children: ReactNode }) {
  return (
    <div role="alert" className={clsx('flex items-start gap-2 rounded-xl px-4 py-3', tones[tone])}>
      <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="py-6">
      <Alert>
        {error instanceof Error ? error.message : 'Could not load this page.'}{' '}
        {retry && (
          <button className="font-semibold underline" onClick={retry}>
            Try again
          </button>
        )}
      </Alert>
    </div>
  );
}

export function StatCard({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-ink-2">
        <span>{label}</span>
        {icon && <span className="text-muted" aria-hidden>{icon}</span>}
      </div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
      {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
    </Card>
  );
}

// ─── Form fields ───

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy?: string) => ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {children(id, hintId)}
      {(error || hint) && (
        <p id={hintId} className={clsx('text-sm', error ? 'text-st-closed' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

const control =
  'w-full min-h-11 rounded-xl border border-line bg-surface px-3.5 py-2 text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60';

export function Input({ label, hint, error, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(id, d) => <input id={id} aria-describedby={d} aria-invalid={!!error} className={control} {...rest} />}
    </Field>
  );
}

export function Select({ label, hint, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id, d) => (
        <select id={id} aria-describedby={d} className={control} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function Textarea({ label, hint, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id, d) => <textarea id={id} aria-describedby={d} className={clsx(control, 'min-h-24')} {...rest} />}
    </Field>
  );
}

export const inputClass = control;

// ─── Tables & paging ───

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line text-sm text-muted">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-5 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty && <EmptyState title="Nothing to show yet" />}
    </div>
  );
}

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={clsx('px-5 py-3 align-middle', className)}>{children}</td>
);

export function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-end gap-2" aria-label="Pagination">
      <button className="rounded-lg p-2 hover:bg-surface-2 disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft className="size-5" />
      </button>
      <span className="tabular text-sm text-ink-2">
        Page {page} of {totalPages}
      </span>
      <button className="rounded-lg p-2 hover:bg-surface-2 disabled:opacity-40" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight className="size-5" />
      </button>
    </nav>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'min-h-10 rounded-lg px-4 font-medium transition-colors',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-7 w-12 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-st-active' : 'bg-line')}
      >
        <span className={clsx('absolute top-1 size-5 rounded-full bg-white shadow transition-all', checked ? 'left-6' : 'left-1')} />
      </button>
      <span className="font-medium">{label}</span>
    </label>
  );
}
