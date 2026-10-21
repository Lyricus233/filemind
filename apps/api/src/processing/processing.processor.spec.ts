import {
  ConflictException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';

import {
  PROCESS_FILE_JOB,
  type ProcessingJobData,
  type ProcessingJobResult,
} from './processing-queue.types.js';
import { ProcessingProcessor } from './processing.processor.js';
import { ProcessingService } from './processing.service.js';

describe('ProcessingProcessor', () => {
  const fileId = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';
  const processing = { process: vi.fn() };
  let processor: ProcessingProcessor;
  const job = {
    id: '2bd23a57-6d56-4cbb-8986-9c24acdc1d89',
    name: PROCESS_FILE_JOB,
    data: { fileId },
  } as Job<ProcessingJobData, ProcessingJobResult, string>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    processor = new ProcessingProcessor(
      processing as unknown as ProcessingService,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns the result after the chunk transaction has completed', async () => {
    const result = { fileId, chunkCount: 3, chunkSize: 500, overlap: 100 };
    processing.process.mockResolvedValue(result);
    await expect(processor.process(job)).resolves.toEqual(result);
    expect(processing.process).toHaveBeenCalledWith(fileId);
  });

  it.each([
    new NotFoundException('Stored file not found'),
    new UnsupportedMediaTypeException(
      'Only UTF-8 .txt and .md files are supported',
    ),
    new UnprocessableEntityException('File is not valid UTF-8'),
  ])('does not retry a permanent input error: %s', async (error) => {
    processing.process.mockRejectedValue(error);
    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(processor.process(job)).rejects.toThrow(error.message);
  });

  it.each([
    new ConflictException('Processing conflict; retry the request'),
    new Error('Database connection lost; internal connection details'),
  ])(
    'allows retrying a transient failure without exposing its internals: %s',
    async (error) => {
      processing.process.mockRejectedValue(error);
      const failure = await processor
        .process(job)
        .catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(UnrecoverableError);
      expect((failure as Error).message).toBe(
        'File processing failed; see worker logs',
      );
    },
  );

  it('rejects an unsupported job name', async () => {
    const unknownJob = {
      id: job.id,
      name: 'unknown',
      data: { fileId },
    } as typeof job;

    await expect(processor.process(unknownJob)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(processing.process).not.toHaveBeenCalled();
  });
});
