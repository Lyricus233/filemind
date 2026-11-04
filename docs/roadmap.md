# FileMind development roadmap

FileMind is currently a backend with a working text retrieval pipeline. This list
tracks remaining product capabilities rather than a percentage-complete estimate.

## Implemented

- NestJS/TypeScript API, Prisma/PostgreSQL, pnpm tooling and CI checks.
- File upload, metadata listing/detail and streaming download with local storage.
- SHA-256 content hashes, paginated duplicate detection and resumable legacy hash
  backfill.
- Strict UTF-8 TXT/Markdown extraction, chunking and source offsets.
- Separate BullMQ/Redis processing worker, bounded retries and job status APIs.
- Literal chunk search with match ranges and pagination.
- Configurable remote embeddings through the OpenAI SDK; Qwen is the current model.
- Milvus vector storage, cosine search, model/dimension checks and file filters.
- Text indexing lifecycle and semantic search returning original source passages.
- Retryable file deletion across local storage, PostgreSQL and tracked Milvus
  collections, with processing/deletion coordination.
- Unit, API, real Milvus and complete retrieval integration tests.

## Next backend milestones

1. **File/index management:** bulk indexing, index rebuilding,
   orphan cleanup and durable task/progress history.
2. **More document formats:** PDF and DOCX first; then PPTX, spreadsheets and HTML
   as needed. Preserve page/section/table locations and improve structural chunking.
   Add OCR for scanned documents.
3. **Hybrid retrieval:** BM25 and Chinese tokenization, dense/sparse fusion with RRF,
   filename/title retrieval and reranking. Keep relevance evaluation alongside tuning.
4. **Access and API operations:** authentication, ownership/permissions, quotas and
   rate limits, API documentation and consistent error handling.
5. **Deployment and recovery:** API/worker images, environment validation, readiness,
   logs/metrics, backup/restore and an object-storage adapter for original files.
   Milvus's internal MinIO is not yet the original-file storage adapter.

## User-facing integrations

- React/Vite demonstration UI with restrained academic styling: file/chunk browser,
  indexing status, matched passages and scores, embedding metadata and optional
  vector projections. The backend remains usable independently of this UI.
- Local-folder ingestion and incremental synchronization. Browser uploads and
  scanning arbitrary host folders need different ingestion mechanisms.
- Bot/platform adapters that call the same indexing and retrieval APIs.

## Optional extensions

- Multimodal retrieval: image embeddings, OCR/layout integration, cross-modal
  queries and separate embedding-space/index lifecycle management.
- Answer generation with citations, if a retrieval-augmented assistant is desired.
  Source retrieval itself remains useful without generated answers.
- Larger-scale ingestion, concurrency controls and relevance/latency benchmark
  tooling, driven by actual workloads and operational measurements.
