import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { File, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
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

    const storageKey = await this.storage.save(input.buffer);

    let file: File;

    try {
      file = await this.prisma.file.create({
        data: {
          originalName,
          mimeType: input.mimeType,
          sizeBytes: BigInt(input.buffer.byteLength),
          storageKey,
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

  async findAll(query: ListFilesQueryDto) {
    const { page, limit } = query;
    const name = query.name?.trim();

    const where: Prisma.FileWhereInput = name
      ? {
          originalName: {
            contains: name.replace(/[\\%_]/g, '\\$&'),
            mode: 'insensitive',
          },
        }
      : {};

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

    if (file === null) {
      throw new NotFoundException('File not found');
    }

    return this.toResponse(file);
  }

  private toResponse(file: File) {
    return {
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes.toString(),
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }
}
