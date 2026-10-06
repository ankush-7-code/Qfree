-- A patient can hold at most one advance booking per queue per day.
-- (Separate migration: the BOOKED enum value must be committed before it can be used.)
CREATE UNIQUE INDEX "queue_entries_one_booking_per_patient_day"
  ON "queue_entries" ("queue_id", "patient_id", "session_date")
  WHERE "status" = 'BOOKED';

-- Upcoming bookings are listed per queue and date.
CREATE INDEX "queue_entries_bookings" ON "queue_entries" ("queue_id", "session_date") WHERE "status" = 'BOOKED';
