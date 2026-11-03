import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { EmbeddingError } from '../embeddings/embedding-error.js';
import { EmbeddingsService } from '../embeddings/embeddings.service.js';
import { IndexStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorStoreError } from '../vectors/vector-store-error.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';
import type { SemanticSearchQueryDto } from './dto/semantic-search-query.dto.js';

@Injectable()
export class SemanticSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStoreService,
  ) {}

  async search(query: SemanticSearchQueryDto) {
    try {
      const target = await this.vectors.ensureCollection();
      const ready = {
        deletedAt: null,
        indexStatus: IndexStatus.READY,
        vectorCollection: target.collection,
      };
      const response = {
        query: query.q,
        mode: 'semantic' as const,
        metric: 'COSINE' as const,
        model: target.model,
        dimensions: target.dimensions,
        limit: query.limit,
      };
      const eligible = await this.prisma.file.findFirst({
        where: { ...ready, ...(query.fileId ? { id: query.fileId } : {}) },
        select: { id: true },
      });
      if (!eligible) return { ...response, items: [], returned: 0 };
      const hidden = await this.prisma.file.findMany({
        where: {
          vectorCollection: target.collection,
          indexStatus: { in: [IndexStatus.PROCESSING, IndexStatus.FAILED] },
        },
        select: { id: true },
      });
      const embedded = await this.embeddings.embed([query.q]);
      if (
        embedded.model !== target.model ||
        embedded.dimensions !== target.dimensions
      ) {
        throw new EmbeddingError(
          'Query embedding does not match the vector collection',
          'invalid_response',
        );
      }
      const candidates = await this.vectors.search(embedded.vectors[0], {
        limit: query.limit,
        fileId: query.fileId,
        excludeFileIds: hidden.map((file) => file.id),
      });
      if (!candidates.length) return { ...response, items: [], returned: 0 };
      const chunks = await this.prisma.fileChunk.findMany({
        where: {
          id: { in: candidates.map((match) => match.chunkId) },
          file: { ...ready, ...(query.fileId ? { id: query.fileId } : {}) },
        },
        select: {
          id: true,
          index: true,
          content: true,
          startOffset: true,
          endOffset: true,
          file: { select: { id: true, originalName: true, mimeType: true } },
        },
      });
      const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
      const items = candidates.flatMap((match) => {
        const chunk = byId.get(match.chunkId);
        if (
          !chunk ||
          chunk.file.id !== match.fileId ||
          chunk.index !== match.index
        )
          return [];
        return [
          {
            chunkId: chunk.id,
            file: chunk.file,
            index: chunk.index,
            content: chunk.content,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            score: match.score,
          },
        ];
      });
      return { ...response, items, returned: items.length };
    } catch (error) {
      if (
        error instanceof EmbeddingError ||
        error instanceof VectorStoreError
      ) {
        throw new ServiceUnavailableException(
          'Semantic search is unavailable; check the embedding and vector services',
        );
      }
      throw error;
    }
  }
}
