import {
  ConflictException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';

import { EmbeddingError } from '../embeddings/embedding-error.js';
import { VectorStoreError } from '../vectors/vector-store-error.js';
import { ProcessingHistoryService } from './processing-history.service.js';
import {
  PROCESS_FILE_JOB,
  type ProcessingJobData,
  type ProcessingJobResult,
} from './processing-queue.types.js';
import { ProcessingProcessor } from './processing.processor.js';
import { ProcessingService } from './processing.service.js';

describe('ProcessingProcessor', () => {
  const fileId = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';
  const processing = { process: vi.fn(), recordTerminalFailure: vi.fn() };
  const history = { archive: vi.fn() };
  let processor: ProcessingProcessor;
  const jobFixture = {
    id: '2bd23a57-6d56-4cbb-8986-9c24acdc1d89',
    name: PROCESS_FILE_JOB,
    data: { fileId },
  };
  const job = jobFixture as Job<ProcessingJobData, ProcessingJobResult, string>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    processor = new ProcessingProcessor(
      processing as unknown as ProcessingService,
      history as unknown as ProcessingHistoryService,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns the result after the chunk transaction has completed', async () => {
    const result = { fileId, chunkCount: 3, chunkSize: 500, overlap: 100 };
    processing.process.mockResolvedValue(result);
    await expect(processor.process(job)).resolves.toEqual(result);
    expect(processing.process).toHaveBeenCalledWith(fileId, job.id, {
      onProgress: expect.any(Function),
      extractChunks: expect.any(Function),
    });
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
    new EmbeddingError('Invalid API key', 'authentication'),
    new VectorStoreError('Wrong collection schema', 'schema_mismatch'),
  ])('does not retry permanent model or collection errors', async (error) => {
    processing.process.mockRejectedValue(error);
    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it.each([
    new ConflictException('Processing conflict; retry the request'),
    new Error('Database connection lost; internal connection details'),
    new EmbeddingError('Rate limit', 'rate_limit', true),
    new VectorStoreError('Connection lost', 'unavailable', true),
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

  it('archives the completed job after BullMQ acknowledges the result', async () => {
    const result = {
      fileId,
      chunkCount: 3,
      chunkSize: 500,
      overlap: 100,
      indexed: true as const,
      model: 'test-model',
      dimensions: 3,
    };
    await processor.onCompleted(job, result);
    expect(history.archive).toHaveBeenCalledWith(job, {
      state: 'completed',
      result,
    });
  });

  it('archives only terminal failures and releases the file status', async () => {
    const error = new Error('File processing failed; see worker logs');
    const retrying = {
      ...jobFixture,
      getState: vi.fn().mockResolvedValue('delayed'),
    };
    await processor.onFailed(retrying as unknown as typeof job, error);
    expect(history.archive).not.toHaveBeenCalled();
    expect(processing.recordTerminalFailure).not.toHaveBeenCalled();

    const terminal = {
      ...retrying,
      finishedOn: Date.now(),
      failedReason: error.message,
    } as unknown as typeof job;
    await processor.onFailed(terminal, error);
    expect(history.archive).toHaveBeenCalledWith(terminal, {
      state: 'failed',
      error: error.message,
    });
    expect(processing.recordTerminalFailure).toHaveBeenCalledWith(
      fileId,
      job.id,
    );
  });
});
