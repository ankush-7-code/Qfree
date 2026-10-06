import clsx from 'clsx';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarDays, LogIn } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { BookingDay, BookingSlots } from '../../lib/types';
import { clock, dayLabel, slotsLabel } from '../../lib/format';
import { Button, LinkButton } from '../ui/Button';
import { Alert, Card, CardTitle, Spinner } from '../ui/primitives';
import { useToast } from '../ui/Toast';

export const bookingSlotsKey = (queueId: string) => ['queue', queueId, 'booking-slots'] as const;

const unavailableText: Record<NonNullable<BookingDay['unavailable']>, string> = {
  NOT_CONSULTING: 'Not consulting',
  FULL: 'Fully booked',
  NO_TIME_LEFT: 'Fully booked',
};

/** Advance booking: pick a day within the doctor's booking window and reserve a numbered token. */
export function BookingPanel({ queueId }: { queueId: string }) {
  const { user } = useAuth();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: [...bookingSlotsKey(queueId), user?.id], queryFn: () => api.get<BookingSlots>(`/queues/${queueId}/booking-slots`) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: bookingSlotsKey(queueId) });
    qc.invalidateQueries({ queryKey: ['patient', 'bookings'] });
  };
  const book = useMutation({
    mutationFn: (date: string) => api.post<{ tokenLabel: string; date: string; estimatedTime: string | null }>(`/queues/${queueId}/bookings`, { date }),
    onSuccess: (b) => {
      toast({ tone: 'success', title: `Booked — token ${b.tokenLabel}`, body: `${dayLabel(b.date)}, estimated around ${clock(b.estimatedTime)}.` });
      setSelected(null);
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (entryId: string) => api.del(`/queues/${queueId}/bookings/${entryId}`),
    onSuccess: () => {
      toast({ tone: 'info', title: 'Booking cancelled' });
      refresh();
    },
    onError: (err) => toast({ tone: 'error', title: 'Could not cancel', body: errorMessage(err) }),
  });

  if (isLoading) return <Spinner label="Loading available days…" />;
  if (!data || data.advanceBookingDays === 0) return null;
  const day = data.days.find((d) => d.date === selected) ?? null;

  return (
    <Card id="book">
      <CardTitle>
        <span className="flex items-center gap-2">
          <CalendarDays className="size-5 text-brand" aria-hidden /> Book for a later day
        </span>
      </CardTitle>
      <p className="-mt-2 mb-4 text-ink-2">
        Reserve your token up to {data.advanceBookingDays} day{data.advanceBookingDays === 1 ? '' : 's'} ahead. Booked patients are seen first, in booking order.
      </p>

      <div role="radiogroup" aria-label="Choose a day" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {data.days.map((d) => {
          const mine = d.myBooking;
          const disabled = !d.available && !mine;
          return (
            <button
              key={d.date}
              role="radio"
              aria-checked={selected === d.date}
              disabled={disabled}
              onClick={() => setSelected(d.date)}
              className={clsx(
                'flex min-h-20 flex-col items-start rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                selected === d.date ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand',
              )}
            >
              <span className="font-semibold">{dayLabel(d.date)}</span>
              {mine ? (
                <span className="flex items-center gap-1 text-sm font-semibold text-st-active">
                  <CalendarCheck className="size-4" aria-hidden /> Your token {mine.tokenLabel}
                </span>
              ) : d.available ? (
                <>
                  <span className="text-sm text-ink-2">{d.remaining} place{d.remaining === 1 ? '' : 's'} left</span>
                  <span className="text-sm text-muted">from ~{clock(d.nextEstimatedTime)}</span>
                </>
              ) : (
                <span className="text-sm text-muted">{d.unavailable ? unavailableText[d.unavailable] : 'Unavailable'}</span>
              )}
            </button>
          );
        })}
      </div>

      {day && (
        <div className="mt-4 rounded-xl bg-surface-2 p-4">
          <p className="font-semibold">{dayLabel(day.date)}</p>
          <p className="text-ink-2">Consulting hours: {slotsLabel(day.slots)}</p>
          {day.myBooking ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p>
                You have token <strong className="tabular">{day.myBooking.tokenLabel}</strong> for this day.
              </p>
              <Button variant="secondary" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(day.myBooking!.entryId)}>
                Cancel booking
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-1 text-ink-2">
                You would be patient <strong className="text-ink">#{day.booked + 1}</strong> of the day, seen at about <strong className="text-ink">{clock(day.nextEstimatedTime)}</strong>.
                Times are estimates and can shift on the day.
              </p>
              {book.error && (
                <div className="mt-3">
                  <Alert>{errorMessage(book.error)}</Alert>
                </div>
              )}
              <div className="mt-3">
                {!user ? (
                  <LinkButton to={`/login?next=${encodeURIComponent(location.pathname)}`} icon={<LogIn className="size-5" />}>
                    Sign in to book
                  </LinkButton>
                ) : user.role === 'PATIENT' ? (
                  <Button size="lg" icon={<CalendarCheck className="size-5" />} loading={book.isPending} onClick={() => book.mutate(day.date)}>
                    Book appointment
                  </Button>
                ) : (
                  <p className="text-ink-2">Only patient accounts can book appointments.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
