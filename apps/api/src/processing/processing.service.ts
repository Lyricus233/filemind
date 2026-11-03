import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { EmbeddingError } from '../embeddings/embedding-error.js';
import { EmbeddingsService } from '../embeddings/embeddings.service.js';
import { IndexStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';
import type { ListChunksQueryDto } from './dto/list-chunks-query.dto.js';
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  extractText,
  splitText,
} from './text-processing.js';

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStoreService,
  ) {}

  async process(id: string, jobId: string = randomUUID()) {
    const file = await this.findFile(id);
    id = file.id;
    let claimed = false;
    try {
      if (file.storageKey === null)
        throw new NotFoundException('File content is unavailable');
      let buffer: Buffer;
      try {
        buffer = await this.storage.read(file.storageKey);
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT')
          throw new NotFoundException('Stored file not found');
        throw error;
      }
      const chunks = splitText(extractText(file.originalName, buffer));
      const target = await this.vectors.ensureCollection();
      const embedded = await this.embeddings.embed(
        chunks.map((chunk) => chunk.content),
      );
      if (
        embedded.model !== target.model ||
        embedded.dimensions !== target.dimensions ||
        embedded.vectors.length !== chunks.length
      ) {
        throw new EmbeddingError(
          'Embedding result does not match the vector collection',
          'invalid_response',
        );
      }

      const data = await this.prisma.$transaction(
        async (tx) => {
          const claim = await tx.file.updateMany({
            where: {
              id,
              OR: [
                { indexStatus: { not: IndexStatus.PROCESSING } },
                { indexJobId: jobId },
              ],
            },
            data: {
              indexStatus: IndexStatus.PROCESSING,
              indexJobId: jobId,
              vectorCollection: target.collection,
              indexedAt: null,
            },
          });
          if (claim.count !== 1)
            throw new ConflictException(
              'Another processing job owns this file',
            );
          const previous = await tx.fileChunk.findMany({
            where: { fileId: id },
            orderBy: { index: 'asc' },
          });
          const oldByIndex = new Map(
            previous.map((chunk) => [chunk.index, chunk]),
          );
          const rows = chunks.map((chunk) => {
            const old = oldByIndex.get(chunk.index);
            const reusable =
              old?.content === chunk.content &&
              old.startOffset === chunk.startOffset &&
              old.endOffset === chunk.endOffset;
            return {
              ...chunk,
              fileId: id,
              id: reusable ? old.id : randomUUID(),
            };
          });
          await tx.fileChunk.deleteMany({ where: { fileId: id } });
          await tx.fileChunk.createMany({ data: rows });
          return rows;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
      claimed = true;
      await this.vectors.deleteByFile(id);
      await this.vectors.upsert(
        data.map((chunk, index) => ({
          chunkId: chunk.id,
          fileId: id,
          index: chunk.index,
          vector: embedded.vectors[index],
        })),
      );
      const published = await this.prisma.file.updateMany({
        where: { id, indexJobId: jobId, indexStatus: IndexStatus.PROCESSING },
        data: { indexStatus: IndexStatus.READY, indexedAt: new Date() },
      });
      if (published.count !== 1)
        throw new ConflictException('Processing job ownership changed');
      return {
        fileId: id,
        chunkCount: chunks.length,
        chunkSize: CHUNK_SIZE,
        overlap: CHUNK_OVERLAP,
        indexed: true,
        model: target.model,
        dimensions: target.dimensions,
      };
    } catch (error) {
      try {
        await this.prisma.file.updateMany({
          where: {
            id,
            ...(claimed
              ? { indexJobId: jobId, indexStatus: IndexStatus.PROCESSING }
              : { indexStatus: IndexStatus.PENDING }),
          },
          data: { indexStatus: IndexStatus.FAILED },
        });
      } catch {
        this.logger.warn(`Could not record indexing failure for file ${id}`);
      }
      const code = getErrorCode(error);

      if (code === 'P2034' || code === 'P2002') {
        throw new ConflictException('Processing conflict; retry the request');
      }

      throw error;
    }
  }

  async findChunks(id: string, query: ListChunksQueryDto) {
    await this.findFile(id);

    const { page, limit } = query;
    const where = { fileId: id };

    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.fileChunk.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { index: 'asc' },
          select: {
            id: true,
            index: true,
            content: true,
            startOffset: true,
            endOffset: true,
            createdAt: true,
          },
        }),
        this.prisma.fileChunk.count({ where }),
      ],
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );

    return {
      fileId: id,
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async findFile(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
      select: { id: true, originalName: true, storageKey: true },
    });

    if (file === null) {
      throw new NotFoundException('File not found');
    }

    return file;
  }
}
