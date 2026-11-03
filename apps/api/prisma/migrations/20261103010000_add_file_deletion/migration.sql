ALTER TABLE "files" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TABLE "file_vector_indexes" (
  "fileId" UUID NOT NULL,
  "collection" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_vector_indexes_pkey" PRIMARY KEY ("fileId", "collection"),
  CONSTRAINT "file_vector_indexes_fileId_fkey" FOREIGN KEY ("fileId")
    REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "file_vector_indexes" ("fileId", "collection")
SELECT "id", "vectorCollection" FROM "files" WHERE "vectorCollection" IS NOT NULL;

CREATE INDEX "files_deletedAt_idx" ON "files"("deletedAt");
