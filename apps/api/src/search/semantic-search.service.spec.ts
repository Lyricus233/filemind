import { ServiceUnavailableException } from '@nestjs/common';

import { EmbeddingError } from '../embeddings/embedding-error.js';
import { EmbeddingsService } from '../embeddings/embeddings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorStoreError } from '../vectors/vector-store-error.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';
import { SemanticSearchService } from './semantic-search.service.js';

describe('SemanticSearchService', () => {
  const fileId = '11111111-1111-4111-8111-111111111111';
  const chunkId = '22222222-2222-4222-8222-222222222222';
  const hiddenId = '33333333-3333-4333-8333-333333333333';
  const target = {
    collection: 'test_chunks',
    model: 'test-model',
    dimensions: 3,
  };
  const query = { q: 'rainy weather', limit: 20 };
  const chunk = {
    id: chunkId,
    index: 0,
    content: '出门记得带雨伞',
    startOffset: 0,
    endOffset: 7,
    source: { format: 'docx', paragraphStart: 1, paragraphEnd: 2 },
    file: { id: fileId, originalName: 'weather.txt', mimeType: 'text/plain' },
  };
  const prisma = {
    file: { findFirst: vi.fn(), findMany: vi.fn() },
    fileChunk: { findMany: vi.fn() },
  };
  const embeddings = { embed: vi.fn() };
  const vectors = { ensureCollection: vi.fn(), search: vi.fn() };
  let service: SemanticSearchService;

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.file.findFirst.mockResolvedValue({ id: fileId });
    prisma.file.findMany.mockResolvedValue([]);
    prisma.fileChunk.findMany.mockResolvedValue([chunk]);
    vectors.ensureCollection.mockResolvedValue(target);
    vectors.search.mockResolvedValue([
      { chunkId, fileId, index: 0, score: 0.9 },
    ]);
    embeddings.embed.mockResolvedValue({
      model: target.model,
      dimensions: 3,
      vectors: [[1, 0, 0]],
    });
    service = new SemanticSearchService(
      prisma as unknown as PrismaService,
      embeddings as unknown as EmbeddingsService,
      vectors as unknown as VectorStoreService,
    );
  });

  it('returns ranked source passages with scores rather than fabricated literal highlights', async () => {
    await expect(service.search(query)).resolves.toMatchObject({
      mode: 'semantic',
      metric: 'COSINE',
      model: target.model,
      dimensions: 3,
      returned: 1,
      items: [
        {
          chunkId,
          content: chunk.content,
          file: chunk.file,
          score: 0.9,
          source: chunk.source,
        },
      ],
    });
    expect(embeddings.embed).toHaveBeenCalledWith(['rainy weather']);
  });

  it('avoids a paid model call when no eligible indexed file exists', async () => {
    prisma.file.findFirst.mockResolvedValue(null);
    await expect(service.search(query)).resolves.toMatchObject({
      items: [],
      returned: 0,
    });
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(vectors.search).not.toHaveBeenCalled();
  });

  it('filters failed/in-progress files inside Milvus and validates readiness again in PostgreSQL', async () => {
    prisma.file.findMany.mockResolvedValue([{ id: hiddenId }]);
    await service.search({ ...query, fileId });
    expect(vectors.search).toHaveBeenCalledWith([1, 0, 0], {
      limit: 20,
      fileId,
      excludeFileIds: [hiddenId],
    });
    expect(prisma.fileChunk.findMany.mock.calls[0][0].where.file).toEqual({
      indexStatus: 'READY',
      vectorCollection: target.collection,
      deletedAt: null,
      id: fileId,
    });
  });

  it('preserves vector ranking when SQL returns chunks in a different order', async () => {
    const second = { ...chunk, id: hiddenId, index: 1 };
    prisma.fileChunk.findMany.mockResolvedValue([second, chunk]);
    vectors.search.mockResolvedValue([
      { chunkId, fileId, index: 0, score: 0.9 },
      { chunkId: hiddenId, fileId, index: 1, score: 0.7 },
    ]);
    const result = await service.search(query);
    expect(result.items.map((item) => item.chunkId)).toEqual([
      chunkId,
      hiddenId,
    ]);
  });

  it.each(['deleted', 'wrong-file', 'wrong-index'])(
    'does not expose a stale %s vector result',
    async (condition) => {
      prisma.fileChunk.findMany.mockResolvedValue(
        condition === 'deleted'
          ? []
          : [
              {
                ...chunk,
                ...(condition === 'wrong-file'
                  ? { file: { ...chunk.file, id: hiddenId } }
                  : { index: 4 }),
              },
            ],
      );
      await expect(service.search(query)).resolves.toMatchObject({
        items: [],
        returned: 0,
      });
    },
  );

  it('does not query source rows when the vector search is empty', async () => {
    vectors.search.mockResolvedValue([]);
    await expect(service.search(query)).resolves.toMatchObject({ returned: 0 });
    expect(prisma.fileChunk.findMany).not.toHaveBeenCalled();
  });

  it.each([
    new EmbeddingError('secret provider body', 'authentication'),
    new VectorStoreError('secret connection', 'unavailable', true),
  ])('returns a sanitized 503 for provider errors', async (error) => {
    embeddings.embed.mockRejectedValue(error);
    await expect(service.search(query)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.search(query)).rejects.toThrow(
      'Semantic search is unavailable; check the embedding and vector services',
    );
  });

  it('rejects a mismatched model before vector search', async () => {
    embeddings.embed.mockResolvedValue({
      model: 'other-model',
      dimensions: 3,
      vectors: [[1, 0, 0]],
    });
    await expect(service.search(query)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(vectors.search).not.toHaveBeenCalled();
  });
});
