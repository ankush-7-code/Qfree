-- CreateEnum
CREATE TYPE "EntrySource" AS ENUM ('SAME_DAY', 'ADVANCE', 'RECEPTION');

-- AlterEnum
ALTER TYPE "EntryStatus" ADD VALUE 'BOOKED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "QueueEventType" ADD VALUE 'BOOKED';
ALTER TYPE "QueueEventType" ADD VALUE 'RECALLED';
ALTER TYPE "QueueEventType" ADD VALUE 'JOINS_STOPPED';
ALTER TYPE "QueueEventType" ADD VALUE 'JOINS_REOPENED';
ALTER TYPE "QueueEventType" ADD VALUE 'WALK_IN_ADDED';

-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "recalled_at" TIMESTAMP(3),
ADD COLUMN     "source" "EntrySource" NOT NULL DEFAULT 'SAME_DAY';

-- AlterTable
ALTER TABLE "queues" ADD COLUMN     "advance_booking_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "advance_booking_quota" INTEGER,
ADD COLUMN     "allow_same_day_join" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "join_cutoff_time" TEXT,
ADD COLUMN     "joins_reopened" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "joins_stopped" BOOLEAN NOT NULL DEFAULT false;

-- ─── Hand-written constraints ───
ALTER TABLE "queues" ADD CONSTRAINT "queues_advance_booking_days_range" CHECK ("advance_booking_days" BETWEEN 0 AND 60);
ALTER TABLE "queues" ADD CONSTRAINT "queues_advance_booking_quota_positive" CHECK ("advance_booking_quota" IS NULL OR "advance_booking_quota" > 0);
ALTER TABLE "queues" ADD CONSTRAINT "queues_join_cutoff_time_format" CHECK ("join_cutoff_time" IS NULL OR "join_cutoff_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
