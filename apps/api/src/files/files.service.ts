import { Injectable, NotFoundException } from '@nestjs/common';

import type { File } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateFileDto } from './dto/create-file.dto.js';
import { ListFilesQueryDto } from './dto/list-files-query.dto.js';

@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createFileDto: CreateFileDto) {
    const file = await this.prisma.file.create({
      data: {
        originalName: createFileDto.originalName,
        mimeType: createFileDto.mimeType,
        sizeBytes: BigInt(createFileDto.sizeBytes),
      },
    });

    return this.toResponse(file);
  }

  async findAll(query: ListFilesQueryDto) {
    const { page, limit } = query;

    const [files, total] = await Promise.all([
      this.prisma.file.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.file.count(),
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
