import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ProcessingService } from './processing.service.js';

describe('ProcessingService', () => {
  let service: ProcessingService;

  const file = {
    id: 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f',
    originalName: 'notes.txt',
    storageKey: 'blob-key',
  };

  const transaction = {
    fileChunk: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };

  const prisma = {
    file: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };

  const storage = { read: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.file.findUnique.mockResolvedValue(file);
    storage.read.mockResolvedValue(Buffer.from('hello'));
    transaction.fileChunk.deleteMany.mockResolvedValue({ count: 0 });
    transaction.fileChunk.createMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      async (operation: (tx: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    );

    const module = await Test.createTestingModule({
      providers: [
        ProcessingService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(ProcessingService);
  });

  it('extracts content and writes chunks associated with the source file', async () => {
    const result = await service.process(file.id);

    expect(result).toEqual({
      fileId: file.id,
      chunkCount: 1,
      chunkSize: 500,
      overlap: 100,
    });
    expect(transaction.fileChunk.createMany).toHaveBeenCalledWith({
      data: [
        {
          fileId: file.id,
          index: 0,
          content: 'hello',
          startOffset: 0,
          endOffset: 5,
        },
      ],
    });
  });

  it('rejects a missing file without reading storage', async () => {
    prisma.file.findUnique.mockResolvedValue(null);

    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.read).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a metadata-only record without opening a write transaction', async () => {
    prisma.file.findUnique.mockResolvedValue({ ...file, storageKey: null });

    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid content before replacing existing chunks', async () => {
    storage.read.mockResolvedValue(Buffer.from([0xc3, 0x28]));

    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps a missing stored file to 404 without starting a transaction', async () => {
    storage.read.mockRejectedValue(
      Object.assign(new Error('Missing file'), { code: 'ENOENT' }),
    );

    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['P2034', 'P2002'])(
    'maps a %s transaction conflict to 409',
    async (code) => {
      prisma.$transaction.mockRejectedValue(
        Object.assign(new Error('Conflict'), { code }),
      );

      await expect(service.process(file.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );
});
