import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';

@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly vectors: VectorStoreService,
  ) {}

  async listPending(limit: number, after?: string) {
    const rows = await this.prisma.file.findMany({
      where: {
        deletedAt: { not: null },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: { id: true, originalName: true, deletedAt: true },
    });
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async resumePending(files: ReadonlyArray<{ id: string }>) {
    const completed: string[] = [];
    const failed: string[] = [];
    for (const { id } of files) {
      try {
        await this.removePending(id);
        completed.push(id);
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException)) throw error;
        failed.push(id);
      }
    }
    return { completed, failed };
  }

  async removePending(id: string): Promise<void> {
    const where = { id, deletedAt: { not: null } };
    try {
      const cleanup = await this.prisma.file.findUnique({
        where,
        select: {
          storageKey: true,
          vectorCollection: true,
          vectorIndexes: { select: { collection: true } },
        },
      });
      if (!cleanup) return;
      const collections = new Set(
        cleanup.vectorIndexes.map((index) => index.collection),
      );
      if (cleanup.vectorCollection) collections.add(cleanup.vectorCollection);
      for (const collection of collections)
        await this.vectors.deleteFromCollection(id, collection);
      if (cleanup.storageKey) await this.storage.remove(cleanup.storageKey);
      await this.prisma.file.deleteMany({ where });
    } catch (error) {
      this.logger.error(
        `File deletion failed for ${id}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        'File deletion is incomplete; retry this DELETE request',
      );
    }
  }
}
