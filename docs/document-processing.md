# PDF and DOCX processing

The existing upload and processing routes now accept UTF-8 TXT/Markdown, text-based
PDF and DOCX files. PDF extraction uses [Mozilla PDF.js](https://github.com/mozilla/pdf.js);
DOCX extraction uses [Mammoth](https://github.com/mwilliamson/mammoth.js). Both run in
the processing worker before embedding requests or index replacement.

## Setup

From `apps/api`, install the parsing dependencies when setting up the project:

```powershell
pnpm install
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm run build
```

Restart the API and worker. The new migration adds a nullable JSON `source` column
to `file_chunks`. Existing text chunks keep `source: null`. Existing files can be
processed again through `POST /files/:id/process`.

## Submit a batch

Send `POST /files/process` with a JSON body containing 1–20 file UUIDs. The
response has one item per distinct UUID in first-seen order. Uppercase and
lowercase spellings of the same UUID count as one file.

```powershell
$body = @{ fileIds = @($first.id, $second.id) } | ConvertTo-Json -Compress
Invoke-RestMethod -NoProxy -Method Post -Uri 'http://127.0.0.1:3000/files/process' -ContentType 'application/json' -Body $body
```

A valid batch returns HTTP 200 with an `items` array. An `accepted` item has
`fileId`, `jobId` and `statusUrl`. Poll `statusUrl` to check indexing progress.
A `failed` item has `fileId`, `statusCode` and `message`. A missing file or a
queue error affects that item alone. Resubmitting a file with an active job
returns that job's ID. An invalid request body returns HTTP 400 before submission.

## Processing history

After applying the processing history migration and restarting the API and worker,
list completed and failed jobs for a file in descending finish order:

```powershell
$fileId = 'replace-with-an-uploaded-file-uuid'
Invoke-RestMethod -NoProxy "http://127.0.0.1:3000/files/$fileId/processing-jobs?page=1&limit=20"
```

The response contains `items`, `page`, `limit` and `hasMore`. Each item records
the final state, last known phase, attempt count, queue and finish timestamps,
and either the result or a failure message. The existing per-job status URL
can serve archived results after Redis has expired the job. Queued and running
jobs still report their live state through the status URL.

The worker archives terminal events from the new version onward. Earlier Redis
jobs follow their original retention policy. If the worker misses the terminal
event or PostgreSQL cannot save it, the Redis status remains available for its
usual retention period. Deleting a file also deletes its archived jobs.

## Try the complete workflow

The repository includes small synthetic documents for testing. From `apps/api`:

```powershell
$samplePath = (Resolve-Path './test/fixtures/two-pages.pdf').Path
$file = curl.exe --noproxy '*' --fail-with-body -sS -F "file=@$samplePath" http://127.0.0.1:3000/files | ConvertFrom-Json
$job = curl.exe --noproxy '*' --fail-with-body -sS -X POST "http://127.0.0.1:3000/files/$($file.id)/process" | ConvertFrom-Json
curl.exe --noproxy '*' --fail-with-body -sS "http://127.0.0.1:3000$($job.statusUrl)"
```

Poll the status URL until the job completes or fails. A completed job means its
chunks and vectors have been saved. Then inspect the chunks and search results:

```powershell
curl.exe --noproxy '*' --fail-with-body -sS "http://127.0.0.1:3000/files/$($file.id)/chunks"
curl.exe --noproxy '*' --fail-with-body -sS -G http://127.0.0.1:3000/search --data-urlencode 'q=数据库索引' --data-urlencode "fileId=$($file.id)"
curl.exe --noproxy '*' --fail-with-body -sS -G http://127.0.0.1:3000/search/semantic --data-urlencode 'q=文件查询' --data-urlencode "fileId=$($file.id)"
```

The literal result should locate the PDF's second page. Repeat with
`./test/fixtures/paragraphs.docx` to inspect DOCX paragraph ranges. Indexing and
semantic queries call the configured embedding API; uploading and literal search
do not. See [Semantic retrieval](semantic-search.md) for service startup and model
configuration.

## Source locations and offsets

Chunk listing, literal search and semantic search expose the same nullable `source`:

```json
{ "format": "pdf", "page": 2 }
```

```json
{ "format": "docx", "paragraphStart": 1, "paragraphEnd": 3 }
```

PDF page numbers are one-based. Blank pages retain their page numbers but produce
no text chunks. A PDF chunk belongs to one page, with the existing 500-character
chunk size and 100-character overlap applied within that page.

DOCX paragraph numbers are one-based positions in Mammoth's extracted text. Empty
paragraphs still occupy a position. These ranges describe extracted paragraphs,
including text extracted from table cells; they are not Word page numbers or XML
node identifiers. Adjacent paragraphs can share a chunk to retain context. DOCX
page numbers depend on document rendering and are not inferred here.

`startOffset` and exclusive `endOffset` count Unicode code points in the normalized
extracted text. For PDF this is the page texts joined with two newline characters;
for DOCX it is the extracted paragraphs joined with two newline characters. They
are not offsets into the PDF/DOCX binary file. Literal `matches` remain offsets
within the returned chunk content. PDF/DOCX source locations are carried through
semantic retrieval without manufacturing character-level semantic highlights.

Unchanged content, offsets and source locations retain the same chunk UUIDs on
reprocessing. Changed locations receive new UUIDs even if their text is unchanged.

## Processing limits and failure behavior

- Upload size remains 10 MiB per file.
- Extracted text is limited to 1,000,000 Unicode code points for every supported format.
- PDFs are limited to 500 pages.
- Password-protected PDFs, invalid documents, NUL characters and documents with no
  searchable text fail processing. Invalid input is terminal and is not retried.
- Image-only PDFs need OCR, which is not implemented. Image-only pages in a mixed
  document contribute no text while its text-bearing pages can still be indexed.

The processing submission itself still returns 202. Inspect the job status for a
terminal failure and its message. Extraction runs before model calls and database
index replacement, so invalid input does not trigger embedding requests or destroy
an already-published index.

This implementation extracts plain text. Complex reading order, columns, charts,
image captions, equations and table structure are not reconstructed. Output limits
are enforced after extraction; archive expansion and parser execution do not yet
have independent memory/time isolation.

## Tests

`pnpm test` parses actual synthetic PDF/DOCX bytes and checks source mapping,
Unicode offsets, empty documents and malformed input. `pnpm run test:e2e` covers
upload, processing, keyword/semantic source hydration, reindexing and deletion.
Its embedding and vector clients use controlled test responses.

`pnpm run test:semantic` repeats the pipeline against real Milvus. As before, it
uses controlled embedding responses unless `FILEMIND_E2E_EMBEDDINGS=real` is set.
Integration tests require a migrated database in `E2E_DATABASE_URL`, not the
development database.
