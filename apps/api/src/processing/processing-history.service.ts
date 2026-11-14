import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListProcessingJobsQueryDto } from './dto/list-processing-jobs-query.dto.js';
import {
  PROCESSING_PHASES,
  type ProcessingJobData,
  type ProcessingJobResult,
  type ProcessingPhase,
  processingPhase,
} from './processing-queue.types.js';

type JobSnapshot = Pick<
  Job<ProcessingJobData>,
  'id' | 'data' | 'attemptsMade' | 'progress' | 'timestamp' | 'finishedOn'
>;

type JobOutcome =
  | { state: 'completed'; result: ProcessingJobResult }
  | { state: 'failed'; error: string };

type ProgressJob = JobSnapshot &
  Pick<Job<ProcessingJobData>, 'attemptsStarted'>;

@Injectable()
export class ProcessingHistoryService {
  private readonly logger = new Logger(ProcessingHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async saveProgress(job: ProgressJob, phase: ProcessingPhase) {
    if (!job.id) return;
    const progress = {
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted,
      phase,
      progressUpdatedAt: new Date(),
    };
    try {
      const inserted = await this.prisma.fileProcessingJob.createMany({
        data: {
          jobId: job.id,
          fileId: job.data.fileId,
          state: 'active',
          queuedAt: new Date(job.timestamp),
          ...progress,
        },
        skipDuplicates: true,
      });
      if (inserted.count > 0) return;
      await this.prisma.fileProcessingJob.updateMany({
        where: {
          jobId: job.id,
          fileId: job.data.fileId,
          state: 'active',
          OR: [
            { attemptsStarted: { lt: job.attemptsStarted } },
            {
              attemptsStarted: job.attemptsStarted,
              phase: {
                in: PROCESSING_PHASES.slice(
                  0,
                  PROCESSING_PHASES.indexOf(phase),
                ),
              },
            },
          ],
        },
        data: progress,
      });
    } catch (error) {
      this.logWriteError(job.id, error);
    }
  }

  async archive(job: JobSnapshot, outcome: JobOutcome) {
    if (!job.id) return;
    const terminal = {
      attemptsMade: job.attemptsMade,
      phase: processingPhase(job.progress),
      finishedAt: new Date(job.finishedOn ?? Date.now()),
      progressUpdatedAt: null,
      ...outcome,
    };
    try {
      const inserted = await this.prisma.fileProcessingJob.createMany({
        data: {
          jobId: job.id,
          fileId: job.data.fileId,
          queuedAt: new Date(job.timestamp),
          ...terminal,
        },
        skipDuplicates: true,
      });
      if (inserted.count > 0) return;
      await this.prisma.fileProcessingJob.updateMany({
        where: { jobId: job.id, fileId: job.data.fileId, state: 'active' },
        data: terminal,
      });
    } catch (error) {
      this.logWriteError(job.id, error);
    }
  }

  findOne(fileId: string, jobId: string) {
    return this.prisma.fileProcessingJob.findFirst({
      where: { fileId, jobId, file: { deletedAt: null } },
      omit: { attemptsStarted: true },
    });
  }

  async list(fileId: string, { page, limit }: ListProcessingJobsQueryDto) {
    const rows = await this.prisma.fileProcessingJob.findMany({
      where: { fileId, finishedAt: { not: null }, file: { deletedAt: null } },
      orderBy: [{ finishedAt: 'desc' }, { jobId: 'desc' }],
      skip: (page - 1) * limit,
      take: limit + 1,
      omit: { attemptsStarted: true, progressUpdatedAt: true },
    });
    return {
      items: rows.slice(0, limit),
      page,
      limit,
      hasMore: rows.length > limit,
    };
  }

  private logWriteError(jobId: string, error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      return;
    }
    this.logger.error(
      `Could not save processing job ${jobId}`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
