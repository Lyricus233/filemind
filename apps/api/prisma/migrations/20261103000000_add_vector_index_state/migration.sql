CREATE TYPE "IndexStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

ALTER TABLE "files"
ADD COLUMN "indexStatus" "IndexStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "indexJobId" UUID,
ADD COLUMN "vectorCollection" TEXT,
ADD COLUMN "indexedAt" TIMESTAMP(3);

CREATE INDEX "files_vectorCollection_indexStatus_idx"
ON "files"("vectorCollection", "indexStatus");
