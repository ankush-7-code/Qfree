-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PATIENT', 'DOCTOR', 'ORG_ADMIN', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('CLINIC', 'LABORATORY', 'HOSPITAL', 'DIAGNOSTIC_CENTER');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'MANAGER', 'RECEPTIONIST');

-- CreateEnum
CREATE TYPE "ServiceCategory" AS ENUM ('CONSULTATION', 'LAB_TEST', 'DIAGNOSTIC', 'PROCEDURE', 'OTHER');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('OPEN', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('WAITING', 'SERVING', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('NORMAL', 'PRIORITY', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "QueueEventType" AS ENUM ('OPENED', 'PAUSED', 'RESUMED', 'CLOSED', 'JOINED', 'CALLED', 'COMPLETED', 'SKIPPED', 'REQUEUED', 'CANCELLED', 'NO_SHOW', 'PRIORITY_CHANGED');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'PATIENT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date_of_birth" DATE,
    "gender" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "description" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "staff_role" "StaffRole" NOT NULL DEFAULT 'RECEPTIONIST',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operating_hours" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "open_time" TEXT NOT NULL,
    "close_time" TEXT NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID,
    "specialization" TEXT NOT NULL,
    "qualification" TEXT,
    "experience_years" INTEGER NOT NULL DEFAULT 0,
    "bio" TEXT,
    "consultation_minutes" INTEGER NOT NULL DEFAULT 10,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_schedules" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,

    CONSTRAINT "doctor_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "description" TEXT,
    "duration_minutes" INTEGER NOT NULL DEFAULT 10,
    "price" DECIMAL(10,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_id" UUID,
    "service_id" UUID,
    "name" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL DEFAULT 'QF',
    "status" "QueueStatus" NOT NULL DEFAULT 'CLOSED',
    "capacity" INTEGER NOT NULL DEFAULT 100,
    "session_date" TEXT,
    "last_token_number" INTEGER NOT NULL DEFAULT 0,
    "avg_service_seconds" INTEGER NOT NULL DEFAULT 600,
    "approaching_threshold" INTEGER NOT NULL DEFAULT 3,
    "opened_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_entries" (
    "id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "session_date" TEXT NOT NULL,
    "token_number" INTEGER NOT NULL,
    "token_label" TEXT NOT NULL,
    "status" "EntryStatus" NOT NULL DEFAULT 'WAITING',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "sort_key" INTEGER NOT NULL,
    "skip_count" INTEGER NOT NULL DEFAULT 0,
    "approaching_notified" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "called_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_events" (
    "id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "entry_id" UUID,
    "actor_id" UUID,
    "type" "QueueEventType" NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_id" UUID,
    "queue_entry_id" UUID,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "patients_user_id_key" ON "patients"("user_id");

-- CreateIndex
CREATE INDEX "organizations_type_idx" ON "organizations"("type");

-- CreateIndex
CREATE INDEX "organizations_city_idx" ON "organizations"("city");

-- CreateIndex
CREATE INDEX "staff_members_user_id_idx" ON "staff_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_organization_id_user_id_key" ON "staff_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "operating_hours_organization_id_day_of_week_key" ON "operating_hours"("organization_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_user_id_key" ON "doctors"("user_id");

-- CreateIndex
CREATE INDEX "doctors_organization_id_idx" ON "doctors"("organization_id");

-- CreateIndex
CREATE INDEX "doctors_specialization_idx" ON "doctors"("specialization");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_schedules_doctor_id_day_of_week_start_time_key" ON "doctor_schedules"("doctor_id", "day_of_week", "start_time");

-- CreateIndex
CREATE UNIQUE INDEX "services_organization_id_name_key" ON "services"("organization_id", "name");

-- CreateIndex
CREATE INDEX "queues_organization_id_idx" ON "queues"("organization_id");

-- CreateIndex
CREATE INDEX "queues_doctor_id_idx" ON "queues"("doctor_id");

-- CreateIndex
CREATE INDEX "queues_status_idx" ON "queues"("status");

-- CreateIndex
CREATE INDEX "queue_entries_queue_id_status_priority_sort_key_idx" ON "queue_entries"("queue_id", "status", "priority", "sort_key");

-- CreateIndex
CREATE INDEX "queue_entries_patient_id_joined_at_idx" ON "queue_entries"("patient_id", "joined_at");

-- CreateIndex
CREATE INDEX "queue_entries_queue_id_session_date_idx" ON "queue_entries"("queue_id", "session_date");

-- CreateIndex
CREATE UNIQUE INDEX "queue_entries_queue_id_session_date_token_number_key" ON "queue_entries"("queue_id", "session_date", "token_number");

-- CreateIndex
CREATE INDEX "queue_events_queue_id_created_at_idx" ON "queue_events"("queue_id", "created_at");

-- CreateIndex
CREATE INDEX "queue_events_entry_id_idx" ON "queue_events"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_queue_entry_id_key" ON "appointments"("queue_entry_id");

-- CreateIndex
CREATE INDEX "appointments_patient_id_scheduled_at_idx" ON "appointments"("patient_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "issues_status_idx" ON "issues"("status");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operating_hours" ADD CONSTRAINT "operating_hours_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "queue_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_queue_entry_id_fkey" FOREIGN KEY ("queue_entry_id") REFERENCES "queue_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written constraints (not expressible in Prisma schema) ───

-- A patient can hold at most one active (waiting/serving) entry per queue.
CREATE UNIQUE INDEX "queue_entries_one_active_per_patient"
  ON "queue_entries" ("queue_id", "patient_id")
  WHERE "status" IN ('WAITING', 'SERVING');

-- At most one patient is being served per queue at any time.
CREATE UNIQUE INDEX "queue_entries_one_serving_per_queue"
  ON "queue_entries" ("queue_id")
  WHERE "status" = 'SERVING';

ALTER TABLE "queues" ADD CONSTRAINT "queues_capacity_positive" CHECK ("capacity" > 0 AND "capacity" <= 5000);
ALTER TABLE "queues" ADD CONSTRAINT "queues_avg_service_positive" CHECK ("avg_service_seconds" > 0);
ALTER TABLE "queues" ADD CONSTRAINT "queues_last_token_nonneg" CHECK ("last_token_number" >= 0);
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_token_positive" CHECK ("token_number" > 0);
ALTER TABLE "operating_hours" ADD CONSTRAINT "operating_hours_day_range" CHECK ("day_of_week" BETWEEN 0 AND 6);
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_day_range" CHECK ("day_of_week" BETWEEN 0 AND 6);
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_consultation_positive" CHECK ("consultation_minutes" > 0);
ALTER TABLE "services" ADD CONSTRAINT "services_duration_positive" CHECK ("duration_minutes" > 0);
