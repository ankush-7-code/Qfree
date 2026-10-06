import clsx from 'clsx';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CalendarDays, Clock, LogIn } from 'lucide-react';
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
  NO_TIME_LEFT: 'No times left today',
};

const isToday = (d: BookingDay, days: BookingDay[]) => d.date === days[0]?.date;

/** Book an appointment: choose a day, then a time slot, then confirm. */
export function BookingPanel({ queueId }: { queueId: string }) {
  const { user } = useAuth();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: [...bookingSlotsKey(queueId), user?.id],
    queryFn: () => api.get<BookingSlots>(`/queues/${queueId}/booking-slots`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: bookingSlotsKey(queueId) });
    qc.invalidateQueries({ queryKey: ['patient'] });
    qc.invalidateQueries({ queryKey: ['queue', queueId, 'status'] });
  };
  const book = useMutation({
    mutationFn: (v: { date: string; time: string }) =>
      api.post<{ tokenLabel: string; date: string; time: string; timeEnd: string }>(`/queues/${queueId}/bookings`, v),
    onSuccess: (b) => {
      toast({ tone: 'success', title: `Booked — token ${b.tokenLabel}`, body: `${dayLabel(b.date)} at ${clock(b.time)}. Please arrive a few minutes early.` });
      setSelectedTime(null);
      refresh();
    },
    onError: () => refresh(),
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
  const day = data.days.find((d) => d.date === selectedDate) ?? null;
  const time = day?.times.find((t) => t.start === selectedTime) ?? null;

  return (
    <Card id="book">
      <CardTitle>
        <span className="flex items-center gap-2">
          <CalendarDays className="size-5 text-brand" aria-hidden /> Book an appointment
        </span>
      </CardTitle>
      <p className="-mt-2 mb-4 text-ink-2">Choose a day and a time — today or up to {data.advanceBookingDays} days ahead.</p>

      <h3 className="mb-2 font-semibold">1. Choose a day</h3>
      <div role="radiogroup" aria-label="Choose a day" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {data.days.map((d) => {
          const mine = d.myBooking;
          return (
            <button
              key={d.date}
              role="radio"
              aria-checked={selectedDate === d.date}
              disabled={!d.available && !mine}
              onClick={() => (setSelectedDate(d.date), setSelectedTime(null), book.reset())}
              className={clsx(
                'flex min-h-20 flex-col items-start rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                selectedDate === d.date ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand',
              )}
            >
              <span className="font-semibold">{isToday(d, data.days) ? `Today, ${dayLabel(d.date).split(', ')[1]}` : dayLabel(d.date)}</span>
              {mine ? (
                <span className="flex items-center gap-1 text-sm font-semibold text-st-active">
                  <CalendarCheck className="size-4" aria-hidden /> {mine.tokenLabel}
                  {mine.appointmentTime && ` · ${clock(mine.appointmentTime)}`}
                </span>
              ) : d.available ? (
                <>
                  <span className="text-sm text-ink-2">{d.times.filter((t) => t.remaining > 0).length} times available</span>
                  <span className="text-sm text-muted">from {clock(d.nextEstimatedTime)}</span>
                </>
              ) : (
                <span className="text-sm text-muted">{d.unavailable ? unavailableText[d.unavailable] : 'Unavailable'}</span>
              )}
            </button>
          );
        })}
      </div>

      {day && day.myBooking && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-st-active-soft p-4">
          <p className="flex-1">
            You are booked for <strong>{dayLabel(day.date)}</strong>
            {day.myBooking.appointmentTime && (
              <>
                {' '}
                at <strong>{clock(day.myBooking.appointmentTime)}</strong>
              </>
            )}{' '}
            — token <strong className="tabular">{day.myBooking.tokenLabel}</strong>.
          </p>
          <Button variant="secondary" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(day.myBooking!.entryId)}>
            Cancel booking
          </Button>
        </div>
      )}

      {day && !day.myBooking && (
        <div className="mt-5">
          <h3 className="mb-1 font-semibold">2. Choose a time</h3>
          <p className="mb-2 text-sm text-ink-2">Consulting hours on {dayLabel(day.date)}: {slotsLabel(day.slots)}</p>
          <div role="radiogroup" aria-label="Choose a time" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {day.times.map((t) => (
              <button
                key={t.start}
                role="radio"
                aria-checked={selectedTime === t.start}
                disabled={t.remaining === 0}
                onClick={() => (setSelectedTime(t.start), book.reset())}
                className={clsx(
                  'flex min-h-14 flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  selectedTime === t.start ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand',
                )}
              >
                <span className="tabular font-semibold whitespace-nowrap">{clock(t.start)}</span>
                <span className="text-xs text-muted">{t.remaining === 0 ? 'Full' : `${t.remaining} left`}</span>
              </button>
            ))}
          </div>
          {!day.times.length && <p className="text-ink-2">No bookable times left on this day.</p>}

          {time && (
            <div className="mt-4 rounded-xl bg-surface-2 p-4">
              <h3 className="font-semibold">3. Confirm</h3>
              <p className="mt-1 flex items-center gap-2 text-lg">
                <Clock className="size-5 text-brand" aria-hidden />
                <span>
                  {dayLabel(day.date)}, <strong>{clock(time.start)} – {clock(time.end)}</strong>
                </span>
              </p>
              <p className="text-sm text-ink-2">You'll get a token number now. Please arrive a few minutes before {clock(time.start)}.</p>
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
                  <Button size="lg" icon={<CalendarCheck className="size-5" />} loading={book.isPending} onClick={() => book.mutate({ date: day.date, time: time.start })}>
                    Book {clock(time.start)}
                  </Button>
                ) : (
                  <p className="text-ink-2">Only patient accounts can book appointments.</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
