import type { Queue } from 'bullmq';

import type { ProcessingService } from './processing.service.js';

export const PROCESSING_QUEUE = 'file-processing';
export const PROCESS_FILE_JOB = 'extract-text';

export interface ProcessingJobData {
  fileId: string;
}

export type ProcessingJobResult = Awaited<
  ReturnType<ProcessingService['process']>
>;

export type ProcessingQueue = Queue<
  ProcessingJobData,
  ProcessingJobResult,
  typeof PROCESS_FILE_JOB
>;
