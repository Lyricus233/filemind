ALTER TYPE "ProcessingJobOutcome" ADD VALUE 'active';

ALTER TABLE "file_processing_jobs"
    ADD COLUMN "attemptsStarted" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "progressUpdatedAt" TIMESTAMP(3),
    ALTER COLUMN "finishedAt" DROP NOT NULL;
