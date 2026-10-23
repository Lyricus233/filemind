import 'reflect-metadata';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchQueryDto } from './dto/search-query.dto.js';
import { SearchService } from './search.service.js';

describe('SearchService', () => {
  const fileId = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';
  const chunk = {
    id: '2bd23a57-6d56-4cbb-8986-9c24acdc1d89',
    index: 1,
    content: '🙂向量搜索与向量索引',
    startOffset: 400,
    endOffset: 410,
    file: { id: fileId, originalName: 'notes.txt', mimeType: 'text/plain' },
  };

  const prisma = {
    fileChunk: { findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  };
  let service: SearchService;

  const query = (values: Partial<SearchQueryDto> = {}) =>
    Object.assign(new SearchQueryDto(), { q: '向量' }, values);

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.fileChunk.findMany.mockResolvedValue([chunk]);
    prisma.fileChunk.count.mockResolvedValue(1);
    prisma.$transaction.mockImplementation((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
    service = new SearchService(prisma as unknown as PrismaService);
  });

  it('returns matching chunks with file metadata and code point ranges', async () => {
    await expect(service.search(query())).resolves.toEqual({
      query: '向量',
      mode: 'literal',
      caseSensitive: true,
      offsetUnit: 'unicode-code-point',
      items: [
        {
          chunkId: chunk.id,
          file: chunk.file,
          index: 1,
          content: chunk.content,
          startOffset: 400,
          endOffset: 410,
          matches: [
            { start: 1, end: 3 },
            { start: 6, end: 8 },
          ],
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
  });

  it('uses one shared filter and a repeatable snapshot for results and count', async () => {
    await service.search(query());
    const listArguments = prisma.fileChunk.findMany.mock.calls[0][0];
    const countArguments = prisma.fileChunk.count.mock.calls[0][0];
    expect(listArguments.where).toEqual({ content: { contains: '向量' } });
    expect(listArguments.where).toBe(countArguments.where);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });

  it('applies stable ordering and offset pagination', async () => {
    prisma.fileChunk.count.mockResolvedValue(23);
    const result = await service.search(query({ page: 2, limit: 10 }));
    expect(prisma.fileChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        orderBy: [{ fileId: 'asc' }, { index: 'asc' }],
      }),
    );
    expect(result).toMatchObject({
      page: 2,
      limit: 10,
      total: 23,
      totalPages: 3,
    });
  });

  it('restricts both results and count to the requested file', async () => {
    await service.search(query({ fileId }));
    expect(prisma.fileChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { content: { contains: '向量' }, fileId },
      }),
    );
    expect(prisma.fileChunk.count).toHaveBeenCalledWith({
      where: { content: { contains: '向量' }, fileId },
    });
  });

  it('escapes LIKE wildcards without changing the literal query or highlight', async () => {
    prisma.fileChunk.findMany.mockResolvedValue([
      { ...chunk, content: '100% complete', startOffset: 0, endOffset: 13 },
    ]);
    const result = await service.search(query({ q: '%' }));
    expect(prisma.fileChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { content: { contains: '\\%' } } }),
    );
    expect(result.query).toBe('%');
    expect(result.items[0].matches).toEqual([{ start: 3, end: 4 }]);
  });

  it('returns an empty successful response when no chunks match', async () => {
    prisma.fileChunk.findMany.mockResolvedValue([]);
    prisma.fileChunk.count.mockResolvedValue(0);
    await expect(service.search(query())).resolves.toMatchObject({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });

  it('preserves the total for a page beyond the last page', async () => {
    prisma.fileChunk.findMany.mockResolvedValue([]);
    prisma.fileChunk.count.mockResolvedValue(1);
    await expect(service.search(query({ page: 2 }))).resolves.toMatchObject({
      items: [],
      total: 1,
      page: 2,
      totalPages: 1,
    });
  });
});
