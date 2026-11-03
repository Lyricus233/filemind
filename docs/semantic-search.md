# Semantic retrieval

The processing worker now extracts text, builds chunks, calls the configured
embedding provider and writes vectors to Milvus. `GET /search/semantic` embeds a
query and returns ranked source chunks from PostgreSQL.

## Run locally

Start PostgreSQL/Redis and Milvus from the repository root:

```powershell
docker compose up -d --wait postgres redis
docker compose --profile vectors up -d --wait --wait-timeout 180 milvus
```

From `apps/api`, configure the existing embedding API key in `.env`, apply migrations
and generate/build the API:

```powershell
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm run build
```

Start the API and worker in two terminals, both from `apps/api`:

```powershell
pnpm run start:dev
```

```powershell
pnpm run start:worker:dev
```

The worker watch command watches compiled files in `dist`; keep the API's watch
compiler running, or rebuild after changing worker code.

## Upload and index a file

The upload endpoint stores a file. Indexing is an explicit request, so uploading
alone does not call a paid model API.

```powershell
$samplePath = Join-Path $env:TEMP 'filemind-weather.txt'
Set-Content -LiteralPath $samplePath -Encoding utf8 -Value '天气预报说明天会下雨，出门时请带一把雨伞。'
$file = curl.exe --noproxy '*' --fail-with-body -sS -F "file=@$samplePath" http://127.0.0.1:3000/files | ConvertFrom-Json
$job = curl.exe --noproxy '*' --fail-with-body -sS -X POST "http://127.0.0.1:3000/files/$($file.id)/process" | ConvertFrom-Json
curl.exe --noproxy '*' --fail-with-body -sS "http://127.0.0.1:3000$($job.statusUrl)"
```

Poll the status URL until `state` is `completed` or `failed`. A completed result
includes `indexed: true`, the embedding model, dimensions and chunk count. Reuse
`POST /files/:id/process` to retry or reindex a file.

Only UTF-8 `.txt` and `.md` extraction is currently supported. The existing upload
limit remains 10 MiB.

## Search by meaning

```powershell
curl.exe --noproxy '*' --fail-with-body -sS -G http://127.0.0.1:3000/search/semantic --data-urlencode 'q=rainy weather' --data-urlencode "fileId=$($file.id)" --data-urlencode 'limit=5'
```

The English query does not occur literally in the Chinese example. A multilingual
embedding model can still retrieve the relevant passage. Retrieval quality depends
on the model and source content.

| Parameter | Meaning |
| --- | --- |
| `q` | Required query, trimmed, 1–1000 Unicode code points, no NUL characters |
| `fileId` | Optional file UUID; restricts retrieval to this file |
| `limit` | Maximum results, 1–100, default 20 |

The response includes `mode: "semantic"`, model, dimensions, `metric: "COSINE"`,
`limit`, `returned` and `items`. Each item contains a chunk ID, file metadata, chunk
index, original content, source offsets and cosine similarity `score`.

Higher scores mean greater similarity; they are not probabilities. This endpoint
returns nearest neighbors without a relevance threshold, pagination or an exact
corpus-wide result count. Semantic matches refer to whole passages; no literal
highlight ranges are invented. `GET /search` retains its existing literal search,
pagination and exact match ranges.

Invalid parameters return 400. Provider/collection failures return a sanitized 503.
A valid file UUID with no ready index returns an empty result.

## Index lifecycle and failure behavior

`GET /files/:id` and the file list now expose `indexStatus` and `indexedAt`:

| Status | Meaning |
| --- | --- |
| `PENDING` | No index has been published, including files predating this migration |
| `PROCESSING` | Source chunks are saved and vector replacement is in progress |
| `READY` | Every vector write completed and the file can be searched semantically |
| `FAILED` | Indexing needs a retry or a configuration/input correction |

The database also records the current collection and owning BullMQ job. These are
internal coordination fields. A serializable transaction claims the file and saves
chunks; network/model requests are kept outside that transaction. Unchanged chunks
retain their UUIDs on reprocessing. Old vectors for the file are deleted before
the new vectors are upserted.

Model extraction/configuration errors stop retries. Temporary provider/network
failures use the existing BullMQ retry policy (three attempts with backoff). New
submissions can recover a file left PROCESSING by an expired or terminal old job.

Failed and in-progress files are excluded inside Milvus searches. Returned chunk
IDs are checked against ready PostgreSQL rows again before serving source content.
PostgreSQL and Milvus do not share a transaction: reindexing temporarily hides a
file from semantic retrieval, and a concurrent query can return fewer than `limit`
items. Literal retrieval can continue to use stored chunks. A model failure before
replacement preserves an already-ready index.

Existing files need an explicit processing request after applying the migration.
Changing the model/embedding space requires a new collection and reindexing files.

## Test boundaries

| Command | Dependencies and coverage |
| --- | --- |
| `pnpm test` | Unit tests; no external services |
| `pnpm run test:e2e` | PostgreSQL/Redis; model and vector-store fixtures |
| `pnpm run test:vectors` | Real Milvus storage operations; synthetic vectors |
| `pnpm run test:semantic` | PostgreSQL/Redis/Milvus; explicit model responses supplied by the test |

Database integration tests require a migrated test database configured by
`E2E_DATABASE_URL` in `.env.test` or the environment. Never use the development
database as the test database. Real Milvus tests use unique collections and remove
them afterward. CI calls no paid model API and requires no model secret.

The embedding stub uses fixed vectors to test indexing, ranking, source-row
lookups and filtering. It does not classify text or implement semantic matching,
and passing these tests is not a measurement of model retrieval quality.
Setting `FILEMIND_E2E_EMBEDDINGS=real` for `test:semantic` instead uses the
configured real provider and asserts that the embedding stub was never called.
That opt-in mode needs valid model configuration and makes billable API requests.

For the standalone storage check, use `pnpm run vectors:check`. For a real model
connection check, use `pnpm run embeddings:check -- "test text"` after building.
