import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { type File, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ListDuplicatesQueryDto } from './dto/list-duplicates-query.dto.js';
import { ListFilesQueryDto } from './dto/list-files-query.dto.js';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async upload(input: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
  }) {
    const originalName = input.originalName.trim();

    if (originalName.length === 0 || originalName.length > 255) {
      throw new BadRequestException(
        'Filename must contain between 1 and 255 characters',
      );
    }

    const contentHash = createHash('sha256').update(input.buffer).digest('hex');
    const storageKey = await this.storage.save(input.buffer);

    let file: File;

    try {
      file = await this.prisma.file.create({
        data: {
          originalName,
          mimeType: input.mimeType,
          sizeBytes: BigInt(input.buffer.byteLength),
          storageKey,
          contentHash,
        },
      });
    } catch (error) {
      try {
        await this.storage.remove(storageKey);
      } catch (cleanupError) {
        this.logger.error(
          `Failed to clean up uploaded file: ${storageKey}`,
          cleanupError,
        );
      }

      throw error;
    }

    return this.toResponse(file);
  }

  async getDownload(id: string) {
    const file = await this.prisma.file.findUnique({
      where: { id },
    });

    if (file === null || file.deletedAt) {
      throw new NotFoundException('File not found');
    }

    if (file.storageKey === null) {
      throw new NotFoundException('File content is unavailable');
    }

    try {
      const stream = await this.storage.openReadStream(file.storageKey);

      return {
        originalName: file.originalName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        stream,
      };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new NotFoundException('Stored file not found');
      }

      throw error;
    }
  }

  async findAll(query: ListFilesQueryDto) {
    const { page, limit } = query;
    const name = query.name?.trim();

    const where: Prisma.FileWhereInput = {
      deletedAt: null,
      ...(name
        ? {
            originalName: {
              contains: name.replace(/[\\%_]/g, '\\$&'),
              mode: 'insensitive',
            },
          }
        : {}),
    };

    const [files, total] = await Promise.all([
      this.prisma.file.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.file.count({ where }),
    ]);

    return {
      items: files.map((file) => this.toResponse(file)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const file = await this.prisma.file.findUnique({
      where: {
        id,
      },
    });

    if (file === null || file.deletedAt) {
      throw new NotFoundException('File not found');
    }

    return this.toResponse(file);
  }

  async findDuplicates(id: string, query: ListDuplicatesQueryDto) {
    const file = await this.prisma.file.findUnique({
      where: { id },
      select: { id: true, contentHash: true, deletedAt: true },
    });
    if (!file || file.deletedAt) throw new NotFoundException('File not found');
    if (!file.contentHash)
      throw new ConflictException({
        statusCode: 409,
        code: 'FILE_HASH_UNAVAILABLE',
        message:
          'File content hash is unavailable; run the hash backfill first',
      });

    const { page, limit } = query;
    const where: Prisma.FileWhereInput = {
      contentHash: file.contentHash,
      deletedAt: null,
      id: { not: file.id },
    };
    const [files, total] = await this.prisma.$transaction(
      [
        this.prisma.file.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        this.prisma.file.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      fileId: file.id,
      algorithm: 'sha256',
      contentHash: file.contentHash,
      items: files.map((item) => this.toResponse(item)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private toResponse(file: File) {
    return {
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes.toString(),
      contentHash: file.contentHash,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      indexStatus: file.indexStatus,
      indexedAt: file.indexedAt,
    };
  }
}
