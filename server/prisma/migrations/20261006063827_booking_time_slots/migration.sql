-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "appointment_time" TEXT;

-- AlterTable
ALTER TABLE "queues" ADD COLUMN     "booking_slot_minutes" INTEGER NOT NULL DEFAULT 30,
ALTER COLUMN "advance_booking_days" SET DEFAULT 7;

-- ─── Hand-written ───
ALTER TABLE "queues" ADD CONSTRAINT "queues_booking_slot_minutes_allowed" CHECK ("booking_slot_minutes" IN (15, 20, 30, 45, 60));
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_appointment_time_format" CHECK ("appointment_time" IS NULL OR "appointment_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Booking is offered by every doctor, clinic and laboratory by default; providers can still turn it off.
UPDATE "queues" SET "advance_booking_days" = 7 WHERE "advance_booking_days" = 0;
