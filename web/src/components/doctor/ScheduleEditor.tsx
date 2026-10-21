import { Plus, Trash2 } from 'lucide-react';
import { clock, DAYS } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardTitle, inputClass } from '../ui/primitives';

export type Slot = { dayOfWeek: number; startTime: string; endTime: string; maxPatients: number | null };

/** Weekly consulting sessions, each with an optional patient limit. Used by doctors and by their clinic. */
export function ScheduleEditor({ value, onChange }: { value: Slot[]; onChange: (slots: Slot[]) => void }) {
  const update = (i: number, patch: Partial<Slot>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <>
    <div className="grid gap-4 md:grid-cols-2">
      {DAYS.map((day, d) => {
        const daySlots = value.map((s, i) => ({ s, i })).filter(({ s }) => s.dayOfWeek === d);
        const limited = daySlots.length > 0 && daySlots.every(({ s }) => s.maxPatients);
        const dayTotal = daySlots.reduce((n, { s }) => n + (s.maxPatients ?? 0), 0);
        return (
          <Card key={day}>
            <CardTitle
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="size-4" />}
                  onClick={() => onChange([...value, { dayOfWeek: d, startTime: daySlots.length ? '17:00' : '09:00', endTime: daySlots.length ? '21:00' : '13:00', maxPatients: null }])}
                >
                  Add session
                </Button>
              }
            >
              {day}
            </CardTitle>
            {daySlots.length === 0 ? (
              <p className="text-muted">Not consulting</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {daySlots.map(({ s, i }) => (
                  <li key={i} className="rounded-xl border border-line p-3">
                    <div className="flex items-center gap-2">
                      <input type="time" aria-label={`${day} session start`} className={inputClass} value={s.startTime} onChange={(e) => update(i, { startTime: e.target.value })} />
                      <span aria-hidden>–</span>
                      <input type="time" aria-label={`${day} session end`} className={inputClass} value={s.endTime} onChange={(e) => update(i, { endTime: e.target.value })} />
                      <button
                        className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-st-closed"
                        onClick={() => onChange(value.filter((_, j) => j !== i))}
                        aria-label={`Remove ${day} session ${clock(s.startTime)}`}
                      >
                        <Trash2 className="size-5" />
                      </button>
                    </div>
                    <label className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">Max patients</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        inputMode="numeric"
                        placeholder="No limit"
                        aria-label={`${day} ${clock(s.startTime)} session patient limit`}
                        className={`${inputClass} w-28`}
                        value={s.maxPatients ?? ''}
                        onChange={(e) => update(i, { maxPatients: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : null })}
                      />
                      <span className="text-sm text-muted">
                        {clock(s.startTime)} – {clock(s.endTime)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {limited && <p className="mt-3 text-sm text-ink-2">Up to {dayTotal} patients on {day}.</p>}
          </Card>
        );
      })}
    </div>
    <p className="mt-4 text-sm text-muted">
      When a session reaches its limit, new patients can't join or book that session; they're offered a later one. Reception can still add a patient over the limit if
      agreed. The queue's overall daily maximum (Queue settings) also still applies.
    </p>
    </>
  );
}
