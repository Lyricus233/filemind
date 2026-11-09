# File deletion and index cleanup

`DELETE /files/:id` removes a file's vectors, original content, chunks and metadata.
Use it after uploading or indexing a disposable file to verify the complete file
lifecycle. This operation permanently removes the stored content.

Content-identical uploads keep separate file records and stored content. Removing
one copy does not remove another copy. See [Content hashes and duplicate detection](file-duplicates.md)
to find copies before deciding which files to index or delete.

## Run locally

From `apps/api`, apply the migration, regenerate the Prisma client and build:

```powershell
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm run build
```

Restart the API and worker after updating the schema and code. For an indexed
file, PostgreSQL, the file store and the Milvus server used by its tracked indexes
must be available. Deleting a file that has never been indexed does not connect
to Milvus or call the embedding API.

Use the file ID returned by the upload endpoint:

```powershell
$fileId = 'replace-with-an-uploaded-file-uuid'
curl.exe --noproxy '*' --fail-with-body -i -X DELETE "http://127.0.0.1:3000/files/$fileId"
curl.exe --noproxy '*' -i "http://127.0.0.1:3000/files/$fileId"
```

The first request should return 204 with no body. The second should return 404.
Repeating the DELETE should still return 204. An end-to-end upload, indexing and
search example is in [Semantic retrieval](semantic-search.md).

| Response | Meaning and next step                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| 204      | Cleanup completed, or the file was already absent                                                           |
| 400      | The path parameter is not a valid UUID                                                                      |
| 409      | A processing job owns the file's index writes; wait for it to finish and retry                              |
| 503      | A required service is unavailable or cleanup is incomplete; restore availability and repeat the same DELETE |

The endpoint does not require an embedding model call. Historical index cleanup
uses the Milvus connection configuration independently of the currently configured
embedding model and dimensions.

## Cleanup and recovery

PostgreSQL, the filesystem and Milvus do not share a transaction. The API first
claims deletion by setting the internal `deletedAt` timestamp. This hides the file
from listing, details, download, chunk queries, processing submissions, job status
and search while physical cleanup runs. Requests that already read the file before
the deletion claim can still finish.

Cleanup runs in this order:

1. Delete the file's vectors from every tracked Milvus collection.
2. Remove the original file from storage.
3. Delete the PostgreSQL file row, cascading to its chunks and index records.

If cleanup fails, the file stays hidden and its recovery metadata remains in
PostgreSQL. Repeating `DELETE /files/:id` resumes cleanup; deleting already-removed
vectors or content is safe. A missing collection is treated as already cleaned.
The API returns a sanitized error and logs the underlying failure. There is no
automatic background cleanup task yet, so an incomplete deletion needs another
DELETE request. A 503 does not mean that earlier cleanup steps were rolled back.

Concurrent DELETE requests can safely repeat the same cleanup. A worker that has
already claimed the file for vector writes blocks deletion with 409. A queued job,
or a job still preparing embeddings before its database claim, does not block it.
After deletion, such a job cannot claim the file or recreate its chunks and vectors.
Deletion does not forcibly terminate running jobs.

BullMQ's completed and failed job records keep their existing retention policy.
They are not synchronously removed by file deletion, and the public status endpoint
returns 404 once the file is hidden or gone. PostgreSQL processing history is
hidden with the file and removed when the file row is deleted.

## Collection history

The `file_vector_indexes` table records each collection targeted by a processing
transaction, including attempts that fail during vector writes. This allows deletion
to clean previous embedding spaces after a model or collection change. Cleanup
deletes only rows matching the file ID; shared collections remain available.

The migration backfills each existing file's recorded `vectorCollection`. It cannot
discover unrecorded orphan vectors left in other collections before history tracking
was introduced. Orphan discovery and bulk cleanup remain future work.

## Verification

Unit tests cover cleanup order, concurrent claims and retrying partial failures.
`pnpm run test:e2e` checks the HTTP lifecycle against PostgreSQL and Redis using
model/vector fixtures. `pnpm run test:semantic` repeats it against real Milvus,
including a historical collection with different model metadata and dimensions.

Both suites exercise disk cleanup failure and deletion during processing. The
model-stub mode also holds an embedding request in flight to verify that deleting
its file prevents later index writes. Integration tests require a migrated test
database in `E2E_DATABASE_URL`; see [Test boundaries](semantic-search.md#test-boundaries).
