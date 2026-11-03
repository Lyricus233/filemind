import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { IndexStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProcessingJobsService } from '../processing/processing-jobs.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VectorStoreService } from '../vectors/vector-store.service.js';

@Injectable()
export class FileDeletionService {
  private readonly logger = new Logger(FileDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly vectors: VectorStoreService,
    private readonly jobs: ProcessingJobsService,
  ) {}

  async remove(id: string): Promise<void> {
    const file = await this.prisma.file.findUnique({
      where: { id },
      select: {
        id: true,
        indexStatus: true,
        indexJobId: true,
        deletedAt: true,
      },
    });
    if (!file) return;
    id = file.id;

    if (!file.deletedAt) {
      await this.jobs.releaseAbandoned(file);
      const claimed = await this.prisma.file.updateMany({
        where: {
          id,
          deletedAt: null,
          indexStatus: { not: IndexStatus.PROCESSING },
        },
        data: {
          deletedAt: new Date(),
          indexStatus: IndexStatus.FAILED,
          indexedAt: null,
        },
      });
      if (claimed.count !== 1) {
        const current = await this.prisma.file.findUnique({
          where: { id },
          select: { deletedAt: true },
        });
        if (!current) return;
        if (!current.deletedAt)
          throw new ConflictException(
            'File is being indexed; retry deletion after the job finishes',
          );
      }
    }

    try {
      const cleanup = await this.prisma.file.findUnique({
        where: { id },
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
      await this.prisma.file.deleteMany({
        where: { id, deletedAt: { not: null } },
      });
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
