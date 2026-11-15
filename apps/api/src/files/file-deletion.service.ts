import { ConflictException, Injectable } from '@nestjs/common';

import { IndexStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProcessingJobsService } from '../processing/processing-jobs.service.js';
import { FileCleanupService } from './file-cleanup.service.js';

@Injectable()
export class FileDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cleanup: FileCleanupService,
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

    await this.cleanup.removePending(id);
  }
}
