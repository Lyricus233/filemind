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
});
