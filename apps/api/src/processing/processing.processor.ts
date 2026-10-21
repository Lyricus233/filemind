import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';

import {
  PROCESSING_QUEUE,
  PROCESS_FILE_JOB,
  type ProcessingJobData,
  type ProcessingJobResult,
} from './processing-queue.types.js';
import { ProcessingService } from './processing.service.js';

@Processor(PROCESSING_QUEUE, { concurrency: 1 })
export class ProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ProcessingProcessor.name);

  constructor(private readonly processingService: ProcessingService) {
    super();
  }

  async process(
    job: Job<ProcessingJobData, ProcessingJobResult, string>,
  ): Promise<ProcessingJobResult> {
    if (job.name !== PROCESS_FILE_JOB) {
      throw new UnrecoverableError('Unsupported processing task');
    }

    try {
      return await this.processingService.process(job.data.fileId);
    } catch (error) {
      if (error instanceof HttpException) {
        switch (error.getStatus()) {
          case HttpStatus.NOT_FOUND:
          case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
          case HttpStatus.UNPROCESSABLE_ENTITY:
            throw new UnrecoverableError(error.message);
        }
      }

      this.logger.error(
        `File processing failed for job ${job.id}`,
        error instanceof Error ? error.stack : String(error),
      );

      // A failedReason is exposed by the status API. Keep internal details in logs.
      throw new Error('File processing failed; see worker logs');
    }
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error('Processing worker connection error', error.stack);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    this.logger.warn(
      `Processing job ${job?.id ?? 'unknown'} failed: ${error.message}`,
    );
  }
}
