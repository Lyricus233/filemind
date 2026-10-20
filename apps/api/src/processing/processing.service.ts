import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async process(id: string) {
    const file = await this.findFile(id);

    if (file.storageKey === null) {
      throw new NotFoundException('File content is unavailable');
    }

    let buffer: Buffer;

    try {
      buffer = await this.storage.read(file.storageKey);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        throw new NotFoundException('Stored file not found');
      }

      throw error;
    }

    const text = extractText(file.originalName, buffer);
    const chunks = splitText(text);
    const data = chunks.map((chunk) => ({ ...chunk, fileId: id }));

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.fileChunk.deleteMany({ where: { fileId: id } });
          await tx.fileChunk.createMany({ data });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      const code = getErrorCode(error);

      if (code === 'P2034' || code === 'P2002') {
        throw new ConflictException('Processing conflict; retry the request');
      }

      throw error;
    }

    return {
      fileId: id,
      chunkCount: chunks.length,
      chunkSize: CHUNK_SIZE,
      overlap: CHUNK_OVERLAP,
    };
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
