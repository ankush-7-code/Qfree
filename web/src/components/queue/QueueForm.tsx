import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api';
import type { QueueSnapshot } from '../../lib/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Alert, Input, Select, Toggle } from '../ui/primitives';

interface Option {
  id: string;
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (q: QueueSnapshot) => void;
  organizationId: string;
  /** Existing queue to edit; omit to create. */
  queue?: QueueSnapshot;
  doctors?: Option[];
  services?: Option[];
  /** Fixed doctor (a doctor creating their own queue). */
  fixedDoctorId?: string;
}

/** Create or edit a queue: which doctor/service it serves, token prefix, capacity and expected pace. */
export function QueueFormDialog({ open, onClose, onSaved, organizationId, queue, doctors = [], services = [], fixedDoctorId }: Props) {
  const [f, setF] = useState(() => ({
    name: queue?.name ?? '',
    tokenPrefix: queue?.tokenPrefix ?? 'QF',
    capacity: String(queue?.capacity ?? 100),
    avgServiceMinutes: String(queue?.avgServiceMinutes ?? 10),
    approachingThreshold: String(queue?.approachingThreshold ?? 3),
    doctorId: fixedDoctorId ?? queue?.doctor?.id ?? '',
    serviceId: queue?.service?.id ?? '',
    joinCutoffTime: queue?.closingRules.cutoffTime ?? '',
    allowSameDayJoin: queue?.allowSameDayJoin ?? true,
    advanceBookingDays: String(queue?.advanceBookingDays ?? 3),
    advanceBookingQuota: queue?.advanceBookingQuota ? String(queue.advanceBookingQuota) : '',
  }));
  const set = (k: Exclude<keyof typeof f, 'allowSameDayJoin'>) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        tokenPrefix: f.tokenPrefix,
        capacity: Number(f.capacity),
        avgServiceMinutes: Number(f.avgServiceMinutes),
        approachingThreshold: Number(f.approachingThreshold),
        doctorId: f.doctorId || null,
        serviceId: f.serviceId || null,
        joinCutoffTime: f.joinCutoffTime || null,
        allowSameDayJoin: f.allowSameDayJoin,
        advanceBookingDays: Number(f.advanceBookingDays),
        advanceBookingQuota: f.advanceBookingQuota ? Number(f.advanceBookingQuota) : null,
      };
      return queue ? api.patch<QueueSnapshot>(`/queues/${queue.id}`, body) : api.post<QueueSnapshot>('/queues', { ...body, organizationId });
    },
    onSuccess: (q) => {
      onSaved(q);
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={queue ? 'Edit queue' : 'New queue'}
      footer={
        <Button type="submit" form="queue-form" loading={save.isPending}>
          {queue ? 'Save changes' : 'Create queue'}
        </Button>
      }
    >
      <form id="queue-form" onSubmit={(e: FormEvent) => (e.preventDefault(), save.mutate())} className="flex flex-col gap-4">
        {save.error && <Alert>{errorMessage(save.error)}</Alert>}
        <Input label="Queue name" required minLength={2} value={f.name} onChange={set('name')} placeholder="e.g. General OPD — Dr. Sharma" />
        {!fixedDoctorId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Doctor" value={f.doctorId} onChange={set('doctorId')}>
              <option value="">— None —</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
            <Select label="Service" value={f.serviceId} onChange={set('serviceId')}>
              <option value="">— None —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Token prefix" required pattern="[A-Za-z]{1,4}" maxLength={4} value={f.tokenPrefix} onChange={set('tokenPrefix')} hint={`Tokens look like ${f.tokenPrefix.toUpperCase() || 'QF'}-001`} />
          <Input label="Minutes per patient" type="number" min={1} max={60} step={0.5} required value={f.avgServiceMinutes} onChange={set('avgServiceMinutes')} hint="Starting estimate; QFree learns the real pace." />
          <Input label="Alert when this many are ahead" type="number" min={1} max={20} required value={f.approachingThreshold} onChange={set('approachingThreshold')} />
        </div>

        <fieldset className="flex flex-col gap-4 rounded-xl border border-line p-4">
          <legend className="px-1 font-semibold">When does the day's queue close?</legend>
          <p className="-mt-1 text-sm text-ink-2">New patients stop when either limit is reached, whichever comes first. You can also stop or reopen new patients by hand from the queue board.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Maximum patients per day" type="number" min={1} max={5000} required value={f.capacity} onChange={set('capacity')} hint="Bookings, online and reception patients together." />
            <Input label="Stop accepting new patients at (optional)" type="time" value={f.joinCutoffTime} onChange={set('joinCutoffTime')} hint="Leave empty for no time limit." />
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4 rounded-xl border border-line p-4">
          <legend className="px-1 font-semibold">How patients get a token</legend>
          <Toggle checked={f.allowSameDayJoin} onChange={(v) => setF({ ...f, allowSameDayJoin: v })} label="Patients can join online on the day" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Advance booking" value={f.advanceBookingDays} onChange={set('advanceBookingDays')}>
              <option value="0">Off — same day only</option>
              {[1, 2, 3, 4, 5, 7, 10, 14, 21, 30].map((d) => (
                <option key={d} value={d}>
                  Up to {d} day{d === 1 ? '' : 's'} ahead
                </option>
              ))}
            </Select>
            <Input
              label="Places bookable in advance per day (optional)"
              type="number"
              min={1}
              max={5000}
              value={f.advanceBookingQuota}
              onChange={set('advanceBookingQuota')}
              disabled={f.advanceBookingDays === '0'}
              hint="Keeps the remaining places for on-the-spot patients. Empty = up to the daily maximum."
            />
          </div>
          <p className="text-sm text-ink-2">Reception can always add patients who are present (“Add patient” on the queue board).</p>
        </fieldset>
      </form>
    </Dialog>
  );
}
