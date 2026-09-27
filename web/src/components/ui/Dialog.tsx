import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Accessible modal built on the native <dialog> element (focus trap and Esc handling included). */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/50"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-xl font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="Close">
              <X className="size-5" />
            </button>
          </div>
          <div>{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
