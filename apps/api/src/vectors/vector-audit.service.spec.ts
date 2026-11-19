import { PrismaService } from '../prisma/prisma.service.js';
import { VectorAuditService } from './vector-audit.service.js';
import { VectorStoreService } from './vector-store.service.js';

describe('VectorAuditService', () => {
  it('reports untracked collection references without flagging recorded historical indexes', async () => {
    const references = [
      'missing',
      'legacy',
      'history',
      'untracked',
      'missing',
    ].map((fileId, index) => ({ chunkId: String(index), fileId }));
    const prisma = {
      file: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'legacy', vectorCollection: 'old_index', vectorIndexes: [] },
          {
            id: 'history',
            vectorCollection: 'new_index',
            vectorIndexes: [{ collection: 'old_index' }],
          },
          { id: 'untracked', vectorCollection: 'new_index', vectorIndexes: [] },
        ]),
      },
    };
    const vectors = {
      listChunkReferences: vi
        .fn()
        .mockResolvedValue({ items: references, nextCursor: '4' }),
    };
    const service = new VectorAuditService(
      prisma as unknown as PrismaService,
      vectors as unknown as VectorStoreService,
    );

    await expect(service.audit('old_index', 5)).resolves.toEqual({
      collection: 'old_index',
      scanned: 5,
      findings: [
        { ...references[0], reason: 'missing_file' },
        { ...references[3], reason: 'untracked_collection' },
        { ...references[4], reason: 'missing_file' },
      ],
      nextCursor: '4',
    });
    expect(prisma.file.findMany).toHaveBeenCalledOnce();
    expect(prisma.file.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['missing', 'legacy', 'history', 'untracked'] } },
      select: {
        id: true,
        vectorCollection: true,
        vectorIndexes: {
          where: { collection: 'old_index' },
          select: { collection: true },
        },
      },
    });
  });

  describe('pruning an audited reference', () => {
    const reference = {
      chunkId: '11111111-1111-4111-8111-111111111111',
      fileId: '22222222-2222-4222-8222-222222222222',
    };
    const prisma = {
      file: { findUnique: vi.fn() },
      fileChunk: { findUnique: vi.fn() },
    };
    const vectors = {
      findChunkReference: vi.fn(),
      deleteChunkReference: vi.fn(),
    };
    const service = new VectorAuditService(
      prisma as unknown as PrismaService,
      vectors as unknown as VectorStoreService,
    );

    beforeEach(() => {
      vi.resetAllMocks();
      prisma.file.findUnique.mockResolvedValue(null);
      prisma.fileChunk.findUnique.mockResolvedValue(null);
      vectors.findChunkReference.mockResolvedValue(reference);
      vectors.deleteChunkReference.mockResolvedValue(true);
    });

    it('previews an orphan then rechecks both database records before applying', async () => {
      await expect(
        service.prune('old_index', reference, false),
      ).resolves.toMatchObject({ status: 'orphaned' });
      expect(vectors.deleteChunkReference).not.toHaveBeenCalled();
      await expect(
        service.prune('old_index', reference, true),
      ).resolves.toMatchObject({ status: 'deleted' });
      expect(prisma.file.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.file.findUnique).toHaveBeenLastCalledWith({
        where: { id: reference.fileId },
        select: { id: true },
      });
      expect(prisma.fileChunk.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.fileChunk.findUnique).toHaveBeenLastCalledWith({
        where: { id: reference.chunkId },
        select: { id: true },
      });
      expect(vectors.deleteChunkReference).toHaveBeenCalledExactlyOnceWith(
        'old_index',
        reference,
      );
    });

    it('preserves vectors when the reference changed or either PostgreSQL record exists', async () => {
      vectors.findChunkReference.mockResolvedValueOnce({
        ...reference,
        fileId: reference.chunkId,
      });
      await expect(
        service.prune('old_index', reference, true),
      ).resolves.toMatchObject({ status: 'reference_changed' });
      prisma.file.findUnique.mockResolvedValueOnce({ id: reference.fileId });
      await expect(
        service.prune('old_index', reference, true),
      ).resolves.toMatchObject({ status: 'protected_file' });
      prisma.fileChunk.findUnique.mockResolvedValueOnce({
        id: reference.chunkId,
      });
      await expect(
        service.prune('old_index', reference, true),
      ).resolves.toMatchObject({ status: 'protected_chunk' });
      expect(vectors.deleteChunkReference).not.toHaveBeenCalled();
    });

    it('stops before deletion if PostgreSQL cannot confirm the orphan', async () => {
      prisma.fileChunk.findUnique.mockRejectedValueOnce(
        new Error('database offline'),
      );
      await expect(service.prune('old_index', reference, true)).rejects.toThrow(
        'database offline',
      );
      expect(vectors.deleteChunkReference).not.toHaveBeenCalled();
    });
  });
});
