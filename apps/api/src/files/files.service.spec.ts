import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService } from './files.service.js';

describe('FilesService', () => {
  let service: FilesService;

  const prisma = {
    file: {
      create: vi.fn(),
    },
  };

  const storage = {
    save: vi.fn(),
    remove: vi.fn(),
  };

  const input = {
    originalName: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  };

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
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.upload(input);

    expect(result).toMatchObject({
      originalName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: '5',
    });

    expect(storage.save).toHaveBeenCalledWith(input.buffer);

    expect(prisma.file.create).toHaveBeenCalledWith({
      data: {
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 5n,
        storageKey: 'blob-key',
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
});
