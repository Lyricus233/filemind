import { Readable } from 'node:stream';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService } from './files.service.js';

describe('FilesService', () => {
  let service: FilesService;

  const prisma = {
    file: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const storage = {
    save: vi.fn(),
    remove: vi.fn(),
    openReadStream: vi.fn(),
  };

  const input = {
    originalName: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  };
  const contentHash =
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

  beforeEach(async () => {
    vi.resetAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        FilesService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: StorageService,
          useValue: storage,
        },
      ],
    }).compile();

    service = module.get(FilesService);
  });

  it('stores the file and returns JSON-safe metadata', async () => {
    storage.save.mockResolvedValue('blob-key');

    prisma.file.create.mockResolvedValue({
      id: 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f',
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 5n,
      storageKey: 'blob-key',
      contentHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.upload(input);

    expect(result).toMatchObject({
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: '5',
      contentHash,
    });

    expect(storage.save).toHaveBeenCalledWith(input.buffer);

    expect(prisma.file.create).toHaveBeenCalledWith({
      data: {
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 5n,
        storageKey: 'blob-key',
        contentHash,
      },
    });

    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('removes the stored file when database creation fails', async () => {
    const databaseError = new Error('Database unavailable');

    storage.save.mockResolvedValue('blob-key');
    storage.remove.mockResolvedValue(undefined);
    prisma.file.create.mockRejectedValue(databaseError);

    await expect(service.upload(input)).rejects.toBe(databaseError);

    expect(storage.remove).toHaveBeenCalledWith('blob-key');
  });

  it('does not create metadata when file storage fails', async () => {
    const storageError = new Error('Storage unavailable');

    storage.save.mockRejectedValue(storageError);

    await expect(service.upload(input)).rejects.toBe(storageError);

    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it('hides a file whose deletion is incomplete from metadata requests', async () => {
    prisma.file.findUnique.mockResolvedValue({ deletedAt: new Date() });
    await expect(
      service.findOne('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('findDuplicates', () => {
    const id = 'a1111111-1111-4111-8111-111111111111';
    const query = { page: 2, limit: 1 };

    it('returns paginated, JSON-safe metadata with the same hash and excludes the source', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id,
        contentHash,
        deletedAt: null,
      });
      prisma.$transaction.mockResolvedValue([
        [{ id: 'copy', originalName: 'copy.md', sizeBytes: 5n, contentHash }],
        3,
      ]);
      const result = await service.findDuplicates(id.toUpperCase(), query);
      expect(result).toMatchObject({
        fileId: id,
        algorithm: 'sha256',
        contentHash,
        items: [
          { id: 'copy', originalName: 'copy.md', sizeBytes: '5', contentHash },
        ],
        total: 3,
        page: 2,
        limit: 1,
        totalPages: 3,
      });
      expect(prisma.file.findMany).toHaveBeenCalledWith({
        where: { contentHash, deletedAt: null, id: { not: id } },
        skip: 1,
        take: 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(prisma.file.count).toHaveBeenCalledWith({
        where: { contentHash, deletedAt: null, id: { not: id } },
      });
    });

    it('does not report an unknown legacy hash as proof of no duplicates', async () => {
      prisma.file.findUnique.mockResolvedValue({
        id,
        contentHash: null,
        deletedAt: null,
      });
      try {
        await service.findDuplicates(id, query);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          statusCode: 409,
          code: 'FILE_HASH_UNAVAILABLE',
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([null, { id, deletedAt: new Date(), contentHash }])(
      'rejects a missing or hidden source file: %j',
      async (file) => {
        prisma.file.findUnique.mockResolvedValue(file);
        await expect(service.findDuplicates(id, query)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('getDownload', () => {
    const file = {
      id: 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f',
      originalName: '学习笔记.txt',
      mimeType: 'text/plain',
      sizeBytes: 5n,
      storageKey: 'blob-key',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('returns file metadata and a readable stream', async () => {
      const stream = Readable.from([Buffer.from('hello')]);

      prisma.file.findUnique.mockResolvedValue(file);
      storage.openReadStream.mockResolvedValue(stream);

      const result = await service.getDownload(file.id);

      expect(result).toEqual({
        originalName: file.originalName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        stream,
      });

      expect(storage.openReadStream).toHaveBeenCalledWith(file.storageKey);

      stream.destroy();
    });

    it('rejects a missing file record', async () => {
      prisma.file.findUnique.mockResolvedValue(null);

      await expect(service.getDownload(file.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(storage.openReadStream).not.toHaveBeenCalled();
    });

    it('does not open content for a file marked for deletion', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ...file,
        deletedAt: new Date(),
      });
      await expect(service.getDownload(file.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.openReadStream).not.toHaveBeenCalled();
    });

    it('rejects a record without stored content', async () => {
      prisma.file.findUnique.mockResolvedValue({
        ...file,
        storageKey: null,
      });

      await expect(service.getDownload(file.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(storage.openReadStream).not.toHaveBeenCalled();
    });

    it('maps a missing disk file to a not-found error', async () => {
      prisma.file.findUnique.mockResolvedValue(file);

      storage.openReadStream.mockRejectedValue(
        Object.assign(new Error('Missing file'), {
          code: 'ENOENT',
        }),
      );

      await expect(service.getDownload(file.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('preserves other storage errors', async () => {
      const error = Object.assign(new Error('Permission denied'), {
        code: 'EACCES',
      });

      prisma.file.findUnique.mockResolvedValue(file);
      storage.openReadStream.mockRejectedValue(error);

      await expect(service.getDownload(file.id)).rejects.toBe(error);
    });
  });
});
