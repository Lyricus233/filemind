ALTER TABLE "files" ADD COLUMN "contentHash" CHAR(64);

CREATE INDEX "files_contentHash_deletedAt_idx" ON "files"("contentHash", "deletedAt");
