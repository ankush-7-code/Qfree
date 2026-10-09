-- AlterTable
ALTER TABLE "doctor_schedules" ADD COLUMN     "max_patients" INTEGER;

-- A session limit, when set, is a positive number of patients.
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_max_patients_positive" CHECK ("max_patients" IS NULL OR "max_patients" BETWEEN 1 AND 1000);
