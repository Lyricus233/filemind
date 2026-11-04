# Content hashes and duplicate detection

Each new upload receives a lowercase, 64-character SHA-256 `contentHash`, calculated
from the original file bytes. Upload, file detail and file listing responses expose
this field. Hashing works for any uploaded format and does not require text extraction,
embeddings or Milvus.

Files with the same hash remain independent records with their own stored content
and processing lifecycle. Duplicate detection lets a caller decide which files to
process or delete. It does not merge storage, automatically delete copies or reuse
embeddings between files.

## Find duplicates

```powershell
$samplePath = Join-Path $env:TEMP 'filemind-duplicate.txt'
Set-Content -LiteralPath $samplePath -Encoding utf8 -Value 'A disposable duplicate-detection example.'
$first = curl.exe --noproxy '*' --fail-with-body -sS -F "file=@$samplePath" http://127.0.0.1:3000/files | ConvertFrom-Json
$second = curl.exe --noproxy '*' --fail-with-body -sS -F "file=@$samplePath" http://127.0.0.1:3000/files | ConvertFrom-Json
curl.exe --noproxy '*' --fail-with-body -sS "http://127.0.0.1:3000/files/$($first.id)/duplicates?page=1&limit=20"
```

Both uploads return 201 with distinct IDs and equal `contentHash` values. The
duplicate response contains `fileId`, `algorithm: "sha256"`, `contentHash`, `items`,
`total`, `page`, `limit` and `totalPages`. `items` contains file metadata for other
visible records sharing the hash. The source file itself is excluded. Repeating
the same upload concurrently also creates separate records, which can be found
after those uploads complete.

| Parameter | Meaning                           |
| --------- | --------------------------------- |
| `id`      | Required file UUID in the URL     |
| `page`    | Page number, 1–10000, default 1   |
| `limit`   | Items per page, 1–100, default 20 |

Results are ordered by creation time descending, then UUID descending. Each page's
rows and count use the same database snapshot. Later requests can see new uploads
or deletions. Deleted files and incomplete deletions are excluded. A missing or
hidden source returns 404; invalid parameters return 400.

Renaming a file or changing its MIME type does not affect its content hash. Line
endings, a byte-order mark, whitespace and document metadata are part of the original
bytes, so changing them produces a different hash. This feature detects exact
content duplicates; semantically similar passages use the separate retrieval APIs.

The hash is content metadata, not encryption or proof that stored content has been
verified again at download time.

## Existing files

The migration adds a nullable `contentHash` and an index on `(contentHash, deletedAt)`.
Existing records initially keep `contentHash: null`; the SQL migration does not read
files from disk. Looking up duplicates for a source with no known hash returns 409
with `code: "FILE_HASH_UNAVAILABLE"`.

Duplicate counts cover records whose hashes are already known. Run the backfill
before relying on duplicate counts across a collection containing older files.
From `apps/api`:

```powershell
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm run build
pnpm run files:hash-backfill
```

The command uses `DATABASE_URL` and `STORAGE_DIR` from the existing configuration.
Run it where the original file storage is mounted. It needs PostgreSQL and access
to those files; it does not initialize the API, queue, worker or model client.

It reads at most 100 metadata rows per batch and streams one file at a time. Only
visible files with a null hash are selected. A conditional update prevents it from
overwriting another completed backfill or writing a hash after deletion starts.
The file's `updatedAt` changes when its hash is saved; indexing state and content
remain unchanged.

The JSON summary contains:

| Field         | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `scanned`     | Candidate records visited in this run                       |
| `updated`     | Hashes saved successfully                                   |
| `skipped`     | Records changed concurrently before the hash could be saved |
| `unavailable` | Records with no storage key or missing original content     |
| `failed`      | Other file read or stream failures                          |

Missing or unreadable originals are left with a null hash and do not stop later
files from being processed. The command exits with code 1 if any are unavailable
or fail, or if a database operation fails. Restore the original content or resolve
the storage problem and rerun the command. It skips known hashes and can be run
again safely. Database failures stop the run; hashes already saved are retained.
Obsolete metadata-only records can be removed with `DELETE /files/:id`.

## Verification and cleanup

`pnpm test` covers hash generation, duplicate queries and backfill failures.
`pnpm run test:e2e` uses an isolated test database and temporary storage to check
concurrent identical uploads, pagination, byte differences, deletion filtering,
legacy backfill and deletion during backfill. `pnpm run test:semantic` also checks
the existing retrieval lifecycle against real Milvus.

After the upload example, remove both disposable files:

```powershell
curl.exe --noproxy '*' --fail-with-body -i -X DELETE "http://127.0.0.1:3000/files/$($first.id)"
curl.exe --noproxy '*' --fail-with-body -i -X DELETE "http://127.0.0.1:3000/files/$($second.id)"
```

Deleting one copy does not affect another copy's content or index. See
[File deletion and index cleanup](file-lifecycle.md) for failure and retry behavior.
