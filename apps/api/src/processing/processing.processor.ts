import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';

import { EmbeddingError } from '../embeddings/embedding-error.js';
import { VectorStoreError } from '../vectors/vector-store-error.js';
import { extractChunksInWorker } from './document-extraction.worker.js';
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
      if (!job.id) throw new UnrecoverableError('Processing job ID is missing');
      return await this.processingService.process(job.data.fileId, job.id, {
        onProgress: (phase) => job.updateProgress({ phase }),
        extractChunks: extractChunksInWorker,
      });
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      if (
        (error instanceof EmbeddingError ||
          error instanceof VectorStoreError) &&
        !error.retryable
      ) {
        this.logger.error(
          `File indexing failed for job ${job.id}`,
          error.stack,
        );
        throw new UnrecoverableError(
          'File indexing configuration or input is invalid; see worker logs',
        );
      }
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
  async onFailed(job: Job<ProcessingJobData> | undefined, error: Error) {
    this.logger.warn(
      `Processing job ${job?.id ?? 'unknown'} failed: ${error.message}`,
    );
    if (!job?.id || job.name !== PROCESS_FILE_JOB) return;
    try {
      if ((await job.getState()) === 'failed') {
        await this.processingService.recordTerminalFailure(
          job.data.fileId,
          job.id,
        );
      }
    } catch (cause) {
      this.logger.warn(
        `Could not record terminal failure for job ${job.id}`,
        cause,
      );
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(
      `Processing job ${jobId} lost its worker lock and was requeued`,
    );
  }
}
