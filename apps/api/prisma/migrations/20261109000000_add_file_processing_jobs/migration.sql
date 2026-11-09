CREATE TYPE "ProcessingJobOutcome" AS ENUM ('completed', 'failed');

CREATE TABLE "file_processing_jobs" (
    "jobId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "state" "ProcessingJobOutcome" NOT NULL,
    "attemptsMade" INTEGER NOT NULL,
    "phase" TEXT,
    "result" JSONB,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "file_processing_jobs_pkey" PRIMARY KEY ("jobId"),
    CONSTRAINT "file_processing_jobs_fileId_fkey" FOREIGN KEY ("fileId")
        REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "file_processing_jobs_fileId_finishedAt_jobId_idx"
    ON "file_processing_jobs"("fileId", "finishedAt", "jobId");
