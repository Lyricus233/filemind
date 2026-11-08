import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';

import { IndexStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PROCESSING_PHASES,
  PROCESSING_QUEUE,
  PROCESS_FILE_JOB,
  type ProcessingQueue,
} from './processing-queue.types.js';

@Injectable()
export class ProcessingJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessingJobsService.name);
  private readonly onQueueError = (error: Error) => {
    this.logger.error('Processing queue connection error', error.stack);
  };

  constructor(
    @InjectQueue(PROCESSING_QUEUE)
    private readonly queue: ProcessingQueue,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.queue.on('error', this.onQueueError);
  }

  onModuleDestroy() {
    this.queue.off('error', this.onQueueError);
  }

  async enqueue(fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        storageKey: true,
        indexStatus: true,
        indexJobId: true,
        deletedAt: true,
      },
    });

    if (file === null || file.deletedAt) {
      throw new NotFoundException('File not found');
    }
    fileId = file.id;

    if (file.storageKey === null) {
      throw new NotFoundException('File content is unavailable');
    }

    await this.releaseAbandoned(file);

    const job = await this.withQueue(() =>
      this.queue.add(
        PROCESS_FILE_JOB,
        { fileId },
        {
          jobId: randomUUID(),
          deduplication: { id: fileId },
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 1000 },
        },
      ),
    );

    if (job.id === undefined) {
      throw new ServiceUnavailableException(
        'Processing queue returned no job ID',
      );
    }
    if (file.indexJobId !== job.id) {
      await this.prisma.file.updateMany({
        where: {
          id: fileId,
          deletedAt: null,
          indexJobId: file.indexJobId ?? null,
        },
        data: { indexJobId: job.id },
      });
    }
    return {
      fileId,
      jobId: job.id,
      statusUrl: `/files/${fileId}/processing-jobs/${job.id}`,
    };
  }

  async attachStatus<T extends { id: string; indexJobId: string | null }>(
    file: T,
  ) {
    try {
      const activeId = await this.queue.getDeduplicationJobId(file.id);
      const jobId = activeId ?? file.indexJobId;
      const job = jobId ? await this.queue.getJob(jobId) : undefined;
      if (job?.id && job.data.fileId === file.id) {
        const state = await job.getState();
        if (state !== 'unknown')
          return { ...file, processingJob: { jobId: job.id, state } };
      }
    } catch {
      // The file library remains available when Redis cannot be reached.
    }
    return { ...file, processingJob: null };
  }

  async releaseAbandoned(file: {
    id: string;
    indexStatus: IndexStatus;
    indexJobId: string | null;
  }) {
    if (file.indexStatus === IndexStatus.PROCESSING && file.indexJobId) {
      const previous = await this.withQueue(() =>
        this.queue.getJob(file.indexJobId!),
      );
      const state = previous
        ? await this.withQueue(() => previous.getState())
        : undefined;
      if (
        state === undefined ||
        state === 'unknown' ||
        state === 'failed' ||
        state === 'completed'
      ) {
        await this.prisma.file.updateMany({
          where: {
            id: file.id,
            indexStatus: IndexStatus.PROCESSING,
            indexJobId: file.indexJobId,
            deletedAt: null,
          },
          data: { indexStatus: IndexStatus.FAILED },
        });
      }
    }
  }

  async findOne(fileId: string, jobId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, deletedAt: true },
    });
    if (!file || file.deletedAt) throw new NotFoundException('File not found');
    fileId = file.id;
    const initialJob = await this.withQueue(() => this.queue.getJob(jobId));

    if (initialJob === undefined || initialJob.data.fileId !== fileId) {
      throw new NotFoundException('Processing job not found');
    }

    const state = await this.withQueue(() => initialJob.getState());
    let job = initialJob;

    if (state === 'unknown') {
      throw new NotFoundException('Processing job not found');
    }

    if (state === 'completed' || state === 'failed') {
      // State may have changed after the first getJob() snapshot.
      const refreshedJob = await this.withQueue(() => this.queue.getJob(jobId));

      if (refreshedJob === undefined || refreshedJob.data.fileId !== fileId) {
        throw new NotFoundException('Processing job not found');
      }

      job = refreshedJob;
    }

    const progress = job.progress;
    const phase =
      typeof progress === 'object' && progress !== null && 'phase' in progress
        ? (PROCESSING_PHASES.find(
            (candidate) => candidate === progress.phase,
          ) ?? null)
        : null;
    return {
      fileId,
      jobId,
      state,
      attemptsMade: job.attemptsMade,
      phase,
      result: state === 'completed' ? job.returnvalue : null,
      error: state === 'failed' ? job.failedReason : null,
    };
  }

  private async withQueue<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error(
        'Processing queue operation failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('Processing queue is unavailable');
    }
  }
}
