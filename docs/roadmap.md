# FileMind development roadmap

FileMind has a working retrieval API and a local web workbench. This list tracks
implemented features and remaining product capabilities.

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
- On-demand inspection of stored chunk vectors in the web workbench.
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

The first [React/Vite demo](../apps/web/README.md) covers upload, processing status,
source chunks, keyword and semantic search, and stored vector inspection.

- Optional projections for comparing multiple search results or source chunks.
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
