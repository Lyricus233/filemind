import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { EmbeddingError } from '../embeddings/embedding-error.js';
import { EmbeddingsService } from '../embeddings/embeddings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VectorStoreError } from '../vectors/vector-store-error.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';
import { DocumentExtractorService } from './document-extractor.service.js';
import { ProcessingService } from './processing.service.js';

describe('ProcessingService', () => {
  let service: ProcessingService;

  const file = {
    id: 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f',
    originalName: 'notes.txt',
    storageKey: 'blob-key',
  };

  const transaction = {
    file: { updateMany: vi.fn() },
    fileVectorIndex: { createMany: vi.fn() },
    fileChunk: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };

  const prisma = {
    file: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  };

  const storage = { read: vi.fn() };
  const embeddings = { embed: vi.fn() };
  const vectors = {
    ensureCollection: vi.fn(),
    deleteByFile: vi.fn(),
    upsert: vi.fn(),
  };
  const target = {
    collection: 'test_chunks',
    model: 'test-model',
    dimensions: 3,
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.file.findUnique.mockResolvedValue(file);
    storage.read.mockResolvedValue(Buffer.from('hello'));
    prisma.file.updateMany.mockResolvedValue({ count: 1 });
    transaction.file.updateMany.mockResolvedValue({ count: 1 });
    transaction.fileVectorIndex.createMany.mockResolvedValue({ count: 1 });
    transaction.fileChunk.findMany.mockResolvedValue([]);
    vectors.ensureCollection.mockResolvedValue(target);
    vectors.deleteByFile.mockResolvedValue(undefined);
    vectors.upsert.mockResolvedValue({ count: 1 });
    embeddings.embed.mockResolvedValue({
      model: target.model,
      dimensions: 3,
      vectors: [[1, 0, 0]],
    });
    transaction.fileChunk.deleteMany.mockResolvedValue({ count: 0 });
    transaction.fileChunk.createMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      async (operation: (tx: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    );

    const module = await Test.createTestingModule({
      providers: [
        ProcessingService,
        DocumentExtractorService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: EmbeddingsService, useValue: embeddings },
        { provide: VectorStoreService, useValue: vectors },
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
      indexed: true,
      model: 'test-model',
      dimensions: 3,
    });
    expect(transaction.fileChunk.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: expect.any(String),
          fileId: file.id,
          index: 0,
          content: 'hello',
          startOffset: 0,
          endOffset: 5,
        },
      ],
    });
    expect(embeddings.embed).toHaveBeenCalledWith(['hello']);
    const inserted = transaction.fileChunk.createMany.mock.calls[0][0].data[0];
    expect(vectors.upsert).toHaveBeenCalledWith([
      { chunkId: inserted.id, fileId: file.id, index: 0, vector: [1, 0, 0] },
    ]);
    expect(prisma.file.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { indexStatus: 'READY', indexedAt: expect.any(Date) },
      }),
    );
  });

  it('reuses chunk IDs when retrying unchanged content', async () => {
    const old = {
      id: '11111111-1111-4111-8111-111111111111',
      index: 0,
      content: 'hello',
      startOffset: 0,
      endOffset: 5,
    };
    transaction.fileChunk.findMany.mockResolvedValue([old]);
    await service.process(file.id);
    expect(vectors.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ chunkId: old.id }),
    ]);
  });

  it('preserves existing chunks and vectors if embedding fails before indexing', async () => {
    embeddings.embed.mockRejectedValue(
      new EmbeddingError('Invalid key', 'authentication'),
    );
    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      EmbeddingError,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(vectors.deleteByFile).not.toHaveBeenCalled();
    expect(prisma.file.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: file.id, indexStatus: 'PENDING', deletedAt: null },
      }),
    );
  });

  it('does not overwrite a file owned by another active job', async () => {
    transaction.file.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction.fileChunk.deleteMany).not.toHaveBeenCalled();
    expect(vectors.deleteByFile).not.toHaveBeenCalled();
  });

  it('does not publish a partially written vector index', async () => {
    vectors.upsert.mockRejectedValue(
      new VectorStoreError('Network unavailable', 'unavailable', true),
    );
    await expect(service.process(file.id)).rejects.toBeInstanceOf(
      VectorStoreError,
    );
    expect(prisma.file.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ indexStatus: 'PROCESSING' }),
        data: { indexStatus: 'FAILED' },
      }),
    );
    expect(prisma.file.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ indexStatus: 'READY' }),
      }),
    );
  });

  it('rejects model/collection mismatch before replacing chunks', async () => {
    embeddings.embed.mockResolvedValue({
      model: 'other-model',
      dimensions: 3,
      vectors: [[1, 0, 0]],
    });
    await expect(service.process(file.id)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
