import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const files = await this.prisma.file.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
    return files.map((file) => ({
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes.toString(),
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    }));
  }
}
