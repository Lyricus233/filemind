import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FileHashBackfillService } from './file-hash-backfill.service.js';

describe('FileHashBackfillService', () => {
  const prisma = { file: { findMany: vi.fn(), updateMany: vi.fn() } };
  const storage = { openReadStream: vi.fn() };
  const file = {
    id: '11111111-1111-4111-8111-111111111111',
    storageKey: 'blob',
  };
  let service: FileHashBackfillService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.file.findMany.mockResolvedValue([]);
    prisma.file.updateMany.mockResolvedValue({ count: 1 });
    storage.openReadStream.mockImplementation(async () =>
      Readable.from([Buffer.from('hel'), Buffer.from('lo')]),
    );
    service = new FileHashBackfillService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('hashes streamed original bytes and leaves indexing metadata untouched', async () => {
    prisma.file.findMany.mockResolvedValueOnce([file]);
    await expect(service.run()).resolves.toEqual({
      scanned: 1,
      updated: 1,
      skipped: 0,
      unavailable: 0,
      failed: 0,
    });
    expect(prisma.file.updateMany).toHaveBeenCalledWith({
      where: {
        id: file.id,
        storageKey: file.storageKey,
        contentHash: null,
        deletedAt: null,
      },
      data: {
        contentHash:
          '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      },
    });
  });

  it('does not overwrite a concurrent hash update or deletion', async () => {
    prisma.file.findMany.mockResolvedValueOnce([file]);
    prisma.file.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.run()).resolves.toMatchObject({
      scanned: 1,
      updated: 0,
      skipped: 1,
    });
  });

  it('advances the cursor after unreadable content and continues with later files', async () => {
    const second = {
      id: '22222222-2222-4222-8222-222222222222',
      storageKey: 'next',
    };
    prisma.file.findMany
      .mockResolvedValueOnce([file])
      .mockResolvedValueOnce([second]);
    storage.openReadStream.mockRejectedValueOnce(
      Object.assign(new Error('Missing'), { code: 'ENOENT' }),
    );
    await expect(service.run()).resolves.toEqual({
      scanned: 2,
      updated: 1,
      skipped: 0,
      unavailable: 1,
      failed: 0,
    });
    expect(prisma.file.findMany.mock.calls[1][0].where.id).toEqual({
      gt: file.id,
    });
    expect(prisma.file.updateMany).toHaveBeenCalledOnce();
    expect(prisma.file.updateMany.mock.calls[0][0].where.id).toBe(second.id);
  });

  it('counts metadata-only files as unavailable without opening storage', async () => {
    prisma.file.findMany.mockResolvedValueOnce([{ ...file, storageKey: null }]);
    await expect(service.run()).resolves.toMatchObject({
      unavailable: 1,
      updated: 0,
    });
    expect(storage.openReadStream).not.toHaveBeenCalled();
    expect(prisma.file.updateMany).not.toHaveBeenCalled();
  });

  it('does not save a digest after a stream fails partway through', async () => {
    prisma.file.findMany.mockResolvedValueOnce([file]);
    storage.openReadStream.mockResolvedValue(
      Readable.from(
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('Injected read failure');
        })(),
      ),
    );
    await expect(service.run()).resolves.toMatchObject({
      failed: 1,
      updated: 0,
    });
    expect(prisma.file.updateMany).not.toHaveBeenCalled();
  });

  it('stops on database errors instead of reporting a successful backfill', async () => {
    prisma.file.findMany.mockResolvedValueOnce([file]);
    const error = new Error('Database unavailable');
    prisma.file.updateMany.mockRejectedValueOnce(error);
    await expect(service.run()).rejects.toBe(error);
  });
});
