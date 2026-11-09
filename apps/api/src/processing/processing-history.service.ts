import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListProcessingJobsQueryDto } from './dto/list-processing-jobs-query.dto.js';
import {
  type ProcessingJobData,
  type ProcessingJobResult,
  processingPhase,
} from './processing-queue.types.js';

type JobSnapshot = Pick<
  Job<ProcessingJobData>,
  'id' | 'data' | 'attemptsMade' | 'progress' | 'timestamp' | 'finishedOn'
>;

type JobOutcome =
  | { state: 'completed'; result: ProcessingJobResult }
  | { state: 'failed'; error: string };

@Injectable()
export class ProcessingHistoryService {
  private readonly logger = new Logger(ProcessingHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async archive(job: JobSnapshot, outcome: JobOutcome) {
    if (!job.id) return;
    try {
      await this.prisma.fileProcessingJob.createMany({
        data: {
          jobId: job.id,
          fileId: job.data.fileId,
          attemptsMade: job.attemptsMade,
          phase: processingPhase(job.progress),
          queuedAt: new Date(job.timestamp),
          finishedAt: new Date(job.finishedOn ?? Date.now()),
          ...outcome,
        },
        skipDuplicates: true,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return;
      }
      this.logger.error(
        `Could not archive processing job ${job.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  findOne(fileId: string, jobId: string) {
    return this.prisma.fileProcessingJob.findFirst({
      where: { fileId, jobId, file: { deletedAt: null } },
    });
  }

  async list(fileId: string, { page, limit }: ListProcessingJobsQueryDto) {
    const rows = await this.prisma.fileProcessingJob.findMany({
      where: { fileId, file: { deletedAt: null } },
      orderBy: [{ finishedAt: 'desc' }, { jobId: 'desc' }],
      skip: (page - 1) * limit,
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit),
      page,
      limit,
      hasMore: rows.length > limit,
    };
  }
}
