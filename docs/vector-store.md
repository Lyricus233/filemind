# Milvus vector store

FileMind uses PostgreSQL for files and text chunks, and Milvus for vector similarity
search. The `VectorsModule` exports `VectorStoreService` for the indexing and search
pipeline. The processing worker now embeds text chunks and writes their vectors.
`GET /search/semantic` performs semantic retrieval; `GET /search` remains literal
search. See [Semantic search](semantic-search.md) for the complete workflow.

## Local setup

Install the SDK from `apps/api`:

```powershell
pnpm add @zilliz/milvus2-sdk-node
```

If pnpm reports an ignored `protobufjs` build script, run `pnpm approve-builds`
and select `protobufjs`. Commit the dependency manifest, lockfile and build approval.

From the repository root, start the vector services:

```powershell
docker compose --profile vectors up -d --wait --wait-timeout 180 milvus
docker compose --profile vectors ps
```

The optional `vectors` profile adds Milvus, etcd, MinIO and a one-shot volume
ownership initializer. It follows the official
[Milvus 3.0.3 Compose configuration](https://github.com/milvus-io/milvus/releases/download/v3.0.3/milvus-standalone-docker-compose.yaml),
using named volumes and ports bound to loopback. etcd and MinIO are internal to the
Compose network. The volume initializer prepares permissions for Milvus's non-root
user. Images are pinned together with the official deployment's dependency versions.

The SDK's 3.x series is compatible with Milvus 3.x. PostgreSQL and Redis keep their
existing configuration. Starting the default Compose profile starts only those two
services.

The defaults below can be added to `apps/api/.env` when customization is needed:

```dotenv
MILVUS_ADDRESS=127.0.0.1:19530
MILVUS_COLLECTION=filemind_chunks_v1
```

`MILVUS_ADDRESS` is the SDK's gRPC server address, not an embeddings HTTP endpoint.
For a TLS server, use `https://host:port`. Set the optional `MILVUS_TOKEN` when the
server requires authentication. The local Compose service uses unauthenticated
loopback access.

Loopback connections bypass HTTP proxies inherited from the shell. Remote Milvus
connections keep the SDK's normal proxy behavior.

`EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` also define the collection's embedding
space. They are not duplicated as Milvus-specific settings.

## Verify the server

From `apps/api`:

```powershell
pnpm run build
pnpm run vectors:check
```

This uses a temporary collection with synthetic three-dimensional vectors. It
checks writes, cosine ranking, file filtering, overwriting an existing ID and
deletion. It removes the temporary collection on completion or failure. It does
not call a model API or access the application's file/chunk tables.

Expected output:

```json
{
  "status": "ok",
  "checks": ["upsert", "cosine-search", "file-filter", "read", "overwrite", "delete"],
  "temporaryCollectionRemoved": true
}
```

The same scenario runs as an integration test:

```powershell
pnpm run test:vectors
```

The integration test defaults to `127.0.0.1:19530`. Override
`E2E_MILVUS_ADDRESS` and optionally `E2E_MILVUS_TOKEN` to use another test server.
No PostgreSQL, Redis, remote embedding service or `.env.test` is required for this
test. `pnpm test` runs unit tests without connecting to Milvus.

## Storage contract

| Field         | Type                     | Purpose                              |
| ------------- | ------------------------ | ------------------------------------ |
| `chunk_id`    | VARCHAR(36), primary key | PostgreSQL chunk UUID                |
| `file_id`     | VARCHAR(36)              | File filter and file-scoped deletion |
| `chunk_index` | INT32                    | Chunk order within a file            |
| `embedding`   | FLOAT_VECTOR             | Dense embedding                      |

The service lazily creates/validates the collection, builds an HNSW index using
COSINE and loads it before operations. Parallel callers share initialization.
Initialization can be retried after an error. Connections close with the Nest
module lifecycle.

- `ensureCollection()` validates the configured collection and returns its model
  and dimensions.
- `upsert(chunks)` writes by chunk UUID in batches of 128. Repeating the same IDs
  updates them. Inputs are validated before the first write. Multiple batches are
  not a transaction; after a failure the caller can retry the same IDs.
- `search(vector, { limit, fileId })` returns chunk IDs, file IDs, chunk indices and
  cosine scores, ordered by similarity. Strong consistency makes completed writes
  and deletions visible to subsequent searches. Scores are not probabilities.
- `deleteByFile(fileId)` removes vectors for one validated UUID. It does not delete
  PostgreSQL rows or files, and is safe to repeat.
- `deleteFromCollection(fileId, collection)` removes a file's vectors from a tracked
  collection without requiring the current embedding model/dimensions or creating
  a missing collection. The file deletion API uses it to clean historical indexes;
  see [File deletion and index cleanup](file-lifecycle.md).

The collection description records the FileMind schema version, model and vector
dimensions. A mismatch stops initialization. To change model or vector dimensions,
use a new collection and re-embed the source chunks. Equal vector dimensions alone
do not make embeddings from different models comparable.

`GET /files/:id/chunks/:chunkId/vector` returns the stored coefficients and the
collection's model and dimensions for a chunk from a ready file index. In the
workbench, open **查看切片向量** beside a result or file passage to preview the
first 32 dimensions and copy the full vector as JSON. Inspection reads the
file's recorded collection and uses no embedding API calls.

The check command's synthetic-vector test verifies Milvus independently. Use
`pnpm run embeddings:check -- "text"` to verify the real embedding provider.
