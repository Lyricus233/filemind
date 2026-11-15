import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ProcessingJobsService } from '../processing/processing-jobs.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';
import { FileCleanupService } from './file-cleanup.service.js';
import { FileDeletionService } from './file-deletion.service.js';

describe('FileDeletionService', () => {
  const file = {
    id: '11111111-1111-4111-8111-111111111111',
    storageKey: 'stored-file',
    deletedAt: null,
    indexStatus: 'READY',
    indexJobId: null,
    vectorCollection: 'current_index',
    vectorIndexes: [
      { collection: 'old_index' },
      { collection: 'current_index' },
    ],
  };
  const prisma = {
    file: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const storage = { remove: vi.fn() };
  const vectors = { deleteFromCollection: vi.fn() };
  const jobs = { releaseAbandoned: vi.fn() };
  let service: FileDeletionService;
  let cleanup: FileCleanupService;
  let order: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    order = [];
    prisma.file.findUnique.mockResolvedValue(file);
    prisma.file.updateMany.mockResolvedValue({ count: 1 });
    prisma.file.deleteMany.mockImplementation(async () => {
      order.push('database');
      return { count: 1 };
    });
    storage.remove.mockImplementation(async () => {
      order.push('storage');
    });
    vectors.deleteFromCollection.mockImplementation(async () => {
      order.push('vector');
    });
    jobs.releaseAbandoned.mockResolvedValue(undefined);
    cleanup = new FileCleanupService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      vectors as unknown as VectorStoreService,
    );
    service = new FileDeletionService(
      prisma as unknown as PrismaService,
      cleanup,
      jobs as unknown as ProcessingJobsService,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('marks deletion before cleaning every tracked collection, the blob and metadata', async () => {
    await service.remove(file.id);
    expect(prisma.file.updateMany).toHaveBeenCalledWith({
      where: {
        id: file.id,
        deletedAt: null,
        indexStatus: { not: 'PROCESSING' },
      },
      data: {
        deletedAt: expect.any(Date),
        indexStatus: 'FAILED',
        indexedAt: null,
      },
    });
    expect(vectors.deleteFromCollection.mock.calls).toEqual([
      [file.id, 'old_index'],
      [file.id, 'current_index'],
    ]);
    expect(storage.remove).toHaveBeenCalledWith(file.storageKey);
    expect(prisma.file.deleteMany).toHaveBeenCalledWith({
      where: { id: file.id, deletedAt: { not: null } },
    });
    expect(order).toEqual(['vector', 'vector', 'storage', 'database']);
  });

  it('makes a repeated deletion of a missing file a no-op', async () => {
    prisma.file.findUnique.mockResolvedValue(null);
    await expect(service.remove(file.id)).resolves.toBeUndefined();
    expect(prisma.file.updateMany).not.toHaveBeenCalled();
    expect(vectors.deleteFromCollection).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('does not delete anything when a worker owns the file', async () => {
    prisma.file.updateMany.mockResolvedValue({ count: 0 });
    prisma.file.findUnique
      .mockResolvedValueOnce({ ...file, indexStatus: 'PROCESSING' })
      .mockResolvedValueOnce({ deletedAt: null });
    await expect(service.remove(file.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(vectors.deleteFromCollection).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.file.deleteMany).not.toHaveBeenCalled();
  });

  it('resumes an incomplete deletion without accessing Redis or remarking the file', async () => {
    prisma.file.findUnique.mockResolvedValue({
      ...file,
      deletedAt: new Date(),
    });
    await service.remove(file.id);
    expect(jobs.releaseAbandoned).not.toHaveBeenCalled();
    expect(prisma.file.updateMany).not.toHaveBeenCalled();
    expect(prisma.file.deleteMany).toHaveBeenCalledOnce();
  });

  it('keeps recovery metadata after a vector failure and succeeds when retried', async () => {
    vectors.deleteFromCollection.mockRejectedValueOnce(
      new Error('private server details'),
    );
    await expect(service.remove(file.id)).rejects.toThrow(
      'File deletion is incomplete; retry this DELETE request',
    );
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.file.deleteMany).not.toHaveBeenCalled();
    prisma.file.findUnique.mockResolvedValue({
      ...file,
      deletedAt: new Date(),
    });
    await expect(service.remove(file.id)).resolves.toBeUndefined();
    expect(prisma.file.deleteMany).toHaveBeenCalledOnce();
  });

  it('keeps recovery metadata when disk removal fails', async () => {
    storage.remove.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(service.remove(file.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.file.deleteMany).not.toHaveBeenCalled();
  });

  it('allows retrying after metadata deletion fails', async () => {
    prisma.file.deleteMany.mockRejectedValueOnce(
      new Error('Database disconnected'),
    );
    await expect(service.remove(file.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    prisma.file.findUnique.mockResolvedValue({
      ...file,
      deletedAt: new Date(),
    });
    await expect(service.remove(file.id)).resolves.toBeUndefined();
    expect(storage.remove).toHaveBeenCalledTimes(2);
  });

  it('deletes a never-indexed metadata-only file without vector or disk access', async () => {
    prisma.file.findUnique.mockResolvedValue({
      ...file,
      storageKey: null,
      vectorCollection: null,
      vectorIndexes: [],
    });
    await service.remove(file.id);
    expect(vectors.deleteFromCollection).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.file.deleteMany).toHaveBeenCalledOnce();
  });

  it('continues safely when another DELETE already claimed the file', async () => {
    prisma.file.updateMany.mockResolvedValue({ count: 0 });
    prisma.file.findUnique
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ deletedAt: new Date() });
    await expect(service.remove(file.id)).resolves.toBeUndefined();
    expect(prisma.file.deleteMany).toHaveBeenCalledOnce();
  });

  it('reads index history after claiming deletion so a just-finished reindex is included', async () => {
    prisma.file.findUnique
      .mockResolvedValueOnce({
        ...file,
        vectorCollection: 'old_index',
        vectorIndexes: [{ collection: 'old_index' }],
      })
      .mockResolvedValueOnce(file);
    await service.remove(file.id);
    expect(vectors.deleteFromCollection.mock.calls).toEqual([
      [file.id, 'old_index'],
      [file.id, 'current_index'],
    ]);
  });

  it('previews only marked rows and uses an ID cursor that does not depend on the previous row surviving', async () => {
    const after = '00000000-0000-4000-8000-000000000001';
    const marked = {
      id: file.id,
      originalName: 'deleted.txt',
      deletedAt: new Date(),
    };
    prisma.file.findMany.mockResolvedValue([
      marked,
      { ...marked, id: '22222222-2222-4222-8222-222222222222' },
    ]);
    await expect(cleanup.listPending(1, after)).resolves.toEqual({
      items: [marked],
      nextCursor: file.id,
    });
    expect(prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { gt: after }, deletedAt: { not: null } },
        orderBy: { id: 'asc' },
        take: 2,
      }),
    );
    expect(vectors.deleteFromCollection).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.file.deleteMany).not.toHaveBeenCalled();
  });

  it('continues after a cleanup failure and rechecks the deletion marker before any writes', async () => {
    const secondId = '22222222-2222-4222-8222-222222222222';
    const goneId = '33333333-3333-4333-8333-333333333333';
    vectors.deleteFromCollection.mockRejectedValueOnce(
      new Error('Milvus unavailable'),
    );
    prisma.file.findUnique
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({
        ...file,
        storageKey: 'next-file',
        vectorCollection: null,
        vectorIndexes: [],
      })
      .mockResolvedValueOnce(null);
    await expect(
      cleanup.resumePending([
        { id: file.id },
        { id: secondId },
        { id: goneId },
      ]),
    ).resolves.toEqual({
      completed: [secondId, goneId],
      failed: [file.id],
    });
    expect(
      prisma.file.findUnique.mock.calls.map(([query]) => query.where),
    ).toEqual(
      [file.id, secondId, goneId].map((id) => ({
        id,
        deletedAt: { not: null },
      })),
    );
    expect(prisma.file.updateMany).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith('next-file');
    expect(prisma.file.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: secondId, deletedAt: { not: null } },
    });
  });
});
