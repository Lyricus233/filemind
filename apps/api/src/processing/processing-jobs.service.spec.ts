import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ProcessingJobsService } from './processing-jobs.service.js';
import {
  PROCESS_FILE_JOB,
  type ProcessingQueue,
} from './processing-queue.types.js';

describe('ProcessingJobsService', () => {
  const fileId = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';
  const jobId = '2bd23a57-6d56-4cbb-8986-9c24acdc1d89';
  const queue = { add: vi.fn(), getJob: vi.fn(), on: vi.fn(), off: vi.fn() };
  const prisma = { file: { findUnique: vi.fn() } };
  let service: ProcessingJobsService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.file.findUnique.mockResolvedValue({
      id: fileId,
      storageKey: 'blob-key',
    });
    queue.add.mockResolvedValue({ id: jobId });
    service = new ProcessingJobsService(
      queue as unknown as ProcessingQueue,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('queues only the file ID with active-job deduplication and bounded retries', async () => {
    await expect(service.enqueue(fileId)).resolves.toEqual({
      fileId,
      jobId,
      statusUrl: `/files/${fileId}/processing-jobs/${jobId}`,
    });
    expect(queue.add).toHaveBeenCalledWith(
      PROCESS_FILE_JOB,
      { fileId },
      expect.objectContaining({
        deduplication: { id: fileId },
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }),
    );
  });

  it('returns the job ID reported by BullMQ when the submission is deduplicated', async () => {
    const existingId = '85595c9d-2b47-4d7f-9309-bb93a6a3f894';
    queue.add.mockResolvedValue({ id: existingId });
    expect(await service.enqueue(fileId)).toMatchObject({ jobId: existingId });
  });

  it('rejects a missing file before accessing the queue', async () => {
    prisma.file.findUnique.mockResolvedValue(null);
    await expect(service.enqueue(fileId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects a file without stored content before accessing the queue', async () => {
    prisma.file.findUnique.mockResolvedValue({ id: fileId, storageKey: null });
    await expect(service.enqueue(fileId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns 503 for a queue write failure', async () => {
    queue.add.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.enqueue(fileId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not accept a queue response without an ID', async () => {
    queue.add.mockResolvedValue({});
    await expect(service.enqueue(fileId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('returns 404 for a missing or expired job', async () => {
    queue.getJob.mockResolvedValue(undefined);
    await expect(service.findOne(fileId, jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a job belonging to another file', async () => {
    queue.getJob.mockResolvedValue({ data: { fileId: 'another-file' } });
    await expect(service.findOne(fileId, jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not expose a previous failure as a terminal error while retrying', async () => {
    queue.getJob.mockResolvedValue({
      data: { fileId },
      getState: vi.fn().mockResolvedValue('delayed'),
      attemptsMade: 1,
      returnvalue: null,
      failedReason: 'Previous attempt failed',
    });
    await expect(service.findOne(fileId, jobId)).resolves.toMatchObject({
      state: 'delayed',
      attemptsMade: 1,
      result: null,
      error: null,
    });
  });

  it('reloads a terminal job so a just-completed result is not lost', async () => {
    const result = { fileId, chunkCount: 1, chunkSize: 500, overlap: 100 };
    queue.getJob
      .mockResolvedValueOnce({
        data: { fileId },
        getState: vi.fn().mockResolvedValue('completed'),
        attemptsMade: 0,
        returnvalue: null,
      })
      .mockResolvedValueOnce({
        data: { fileId },
        attemptsMade: 1,
        returnvalue: result,
      });
    await expect(service.findOne(fileId, jobId)).resolves.toMatchObject({
      state: 'completed',
      result,
      error: null,
    });
  });

  it('returns a terminal failure reason', async () => {
    const job = {
      data: { fileId },
      getState: vi.fn().mockResolvedValue('failed'),
      attemptsMade: 1,
      failedReason: 'File is not valid UTF-8',
    };
    queue.getJob.mockResolvedValue(job);
    await expect(service.findOne(fileId, jobId)).resolves.toMatchObject({
      state: 'failed',
      result: null,
      error: 'File is not valid UTF-8',
    });
  });

  it('returns 404 if the job disappears between reading it and reading its state', async () => {
    queue.getJob.mockResolvedValue({
      data: { fileId },
      getState: vi.fn().mockResolvedValue('unknown'),
    });
    await expect(service.findOne(fileId, jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 404 if a terminal job is removed before the second snapshot', async () => {
    queue.getJob
      .mockResolvedValueOnce({
        data: { fileId },
        getState: vi.fn().mockResolvedValue('completed'),
      })
      .mockResolvedValueOnce(undefined);
    await expect(service.findOne(fileId, jobId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 503 for a queue read failure', async () => {
    queue.getJob.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.findOne(fileId, jobId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
