# FileMind development roadmap

FileMind is currently a backend with a working text retrieval pipeline. This list
tracks remaining product capabilities rather than a percentage-complete estimate.

## Implemented

- NestJS/TypeScript API, Prisma/PostgreSQL, pnpm tooling and CI checks.
- File upload, metadata listing/detail and streaming download with local storage.
- SHA-256 content hashes, paginated duplicate detection and resumable legacy hash
  backfill.
- Strict UTF-8 TXT/Markdown extraction, chunking and source offsets.
- PDF/DOCX text extraction with PDF page locations and DOCX paragraph ranges in
  chunk listings and retrieval results.
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
2. **More document formats:** PPTX, spreadsheets and HTML as needed. Improve
   reading order, structural chunking and table/section locations.
   Add OCR for scanned documents.
3. **Hybrid retrieval:** BM25 and Chinese tokenization, dense/sparse fusion with RRF,
   filename/title retrieval and reranking. Keep relevance evaluation alongside tuning.
4. **Access and API operations:** authentication, ownership/permissions, quotas and
   rate limits, API documentation and consistent error handling.
5. **Deployment and recovery:** API/worker images, environment validation, readiness,
   logs/metrics, backup/restore and an object-storage adapter for original files.
   Milvus's internal MinIO is not yet the original-file storage adapter.

## User-facing integrations

The immediate next milestone is the first React/Vite demo in `apps/web`, now that
multi-format indexing and source locations are available. Its first slice covers
upload, file/processing status, source chunks and keyword/semantic search. Vector
inspection can then be added to the same interface. Further backend operations
and document-format work can continue alongside it.

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
