import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getQueueToken, getSharedConfigToken } from '@nestjs/bullmq';
import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EmbeddingsService } from '../src/embeddings/embeddings.service.js';
import { FileHashBackfillService } from '../src/files/file-hash-backfill.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { redisConnection } from '../src/processing/processing-queue.config.js';
import {
  PROCESSING_QUEUE,
  type ProcessingQueue,
} from '../src/processing/processing-queue.types.js';
import { StorageService } from '../src/storage/storage.service.js';
import { assertMilvusSuccess } from '../src/vectors/vector-store-error.js';
import { vectorStoreConfig } from '../src/vectors/vector-store.config.js';
import { VectorStoreService } from '../src/vectors/vector-store.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { FIXTURE_MODEL, FixtureVectorStore } from './semantic-fixtures.js';

interface Chunk {
  id: string;
  index: number;
  content: string;
  startOffset: number;
  endOffset: number;
  source:
    | { format: 'pdf'; page: number }
    | { format: 'docx'; paragraphStart: number; paragraphEnd: number }
    | null;
}

interface JobStatus {
  state: string;
  phase: string | null;
  attemptsMade: number;
  result: { chunkCount: number } | null;
  error: string | null;
}

describe('File retrieval pipeline (e2e)', () => {
  const prefix = `filemind-e2e-${randomUUID()}`;
  const fileIds: string[] = [];
  const collection = `filemind_pipeline_${randomUUID().replaceAll('-', '')}`;
  const ownedCollections = new Set<string>();
  const realVectors = process.env.FILEMIND_E2E_VECTORS === 'real';
  const realEmbeddings = process.env.FILEMIND_E2E_EMBEDDINGS === 'real';
  const fakeVectors = new FixtureVectorStore(collection);
  const embeddingStub = { embed: vi.fn<EmbeddingsService['embed']>() };
  let cleanupClient: MilvusClient | undefined;
  let ownsCollection = false;
  let app: INestApplication | undefined;
  let worker: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let queue: ProcessingQueue | undefined;
  let storageDirectory: string | undefined;

  beforeEach(() => {
    embeddingStub.embed.mockReset();
    embeddingStub.embed.mockImplementation(async (texts) => ({
      model: FIXTURE_MODEL,
      dimensions: 3,
      vectors: texts.map(() => [0, 0, 1]),
    }));
  });

  afterEach(() => {
    if (realEmbeddings) expect(embeddingStub.embed).not.toHaveBeenCalled();
  });

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), 'filemind-e2e-'));
    const config = new ConfigService({
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      STORAGE_DIR: storageDirectory,
      REDIS_HOST: process.env.E2E_REDIS_HOST ?? '127.0.0.1',
      REDIS_PORT: process.env.E2E_REDIS_PORT ?? '6379',
      MILVUS_ADDRESS: process.env.E2E_MILVUS_ADDRESS ?? '127.0.0.1:19530',
      MILVUS_TOKEN: process.env.E2E_MILVUS_TOKEN ?? '',
      MILVUS_COLLECTION: collection,
      EMBEDDING_MODEL: realEmbeddings
        ? process.env.EMBEDDING_MODEL
        : FIXTURE_MODEL,
      EMBEDDING_DIMENSIONS: realEmbeddings
        ? process.env.EMBEDDING_DIMENSIONS
        : '3',
      EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    });

    if (realVectors) {
      cleanupClient = new MilvusClient(vectorStoreConfig(config).client);
      await cleanupClient.connectPromise;
      const existing = await cleanupClient.hasCollection({
        collection_name: collection,
      });
      assertMilvusSuccess(existing.status);
      expect(existing.value).toBe(false);
      ownsCollection = true;
      ownedCollections.add(collection);
    }

    const apiBuilder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(getSharedConfigToken())
      .useValue({
        connection: redisConnection(config, 'api'),
        prefix,
      });
    if (!realEmbeddings)
      apiBuilder.overrideProvider(EmbeddingsService).useValue(embeddingStub);
    if (!realVectors)
      apiBuilder.overrideProvider(VectorStoreService).useValue(fakeVectors);
    const apiModule = await apiBuilder.compile();

    app = apiModule.createNestApplication();
    configureApp(app);
    queue = app.get<ProcessingQueue>(getQueueToken(PROCESSING_QUEUE));
    // Stop before starting a worker if the isolation override ever stops applying.
    expect(queue.opts.prefix).toBe(prefix);
    await app.init();
    prisma = app.get(PrismaService);

    const workerBuilder = Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(getSharedConfigToken())
      .useValue({
        connection: redisConnection(config, 'worker'),
        prefix,
      });
    if (!realEmbeddings)
      workerBuilder.overrideProvider(EmbeddingsService).useValue(embeddingStub);
    if (!realVectors)
      workerBuilder.overrideProvider(VectorStoreService).useValue(fakeVectors);
    worker = await workerBuilder.compile();
    expect(
      worker.get<ProcessingQueue>(getQueueToken(PROCESSING_QUEUE)).opts.prefix,
    ).toBe(prefix);
    await worker.init();
  }, 60000);

  afterAll(async () => {
    try {
      // Finish active test jobs before deleting the files they reference.
      await worker?.close();
      if (prisma && app && fileIds.length > 0) {
        const files = await prisma.file.findMany({
          where: { id: { in: fileIds } },
          select: { storageKey: true },
        });
        await prisma.file.deleteMany({ where: { id: { in: fileIds } } });
        for (const file of files) {
          if (file.storageKey)
            await app.get(StorageService).remove(file.storageKey);
        }
      }
      if (queue && queue.opts.prefix === prefix) {
        await queue.obliterate({ force: true });
      }
    } finally {
      await app?.close();
      try {
        if (cleanupClient && ownsCollection) {
          for (const owned of ownedCollections) {
            if (!/^filemind_(?:pipeline|history)_[0-9a-f]{32}$/u.test(owned))
              continue;
            const exists = await cleanupClient.hasCollection({
              collection_name: owned,
            });
            assertMilvusSuccess(exists.status);
            if (exists.value)
              assertMilvusSuccess(
                await cleanupClient.dropCollection({ collection_name: owned }),
              );
          }
        }
      } finally {
        await cleanupClient?.closeConnection();
        if (storageDirectory) await rmdir(storageDirectory);
      }
    }
  }, 20000);

  async function upload(
    content: Buffer,
    filename = 'e2e-notes.txt',
    contentType = 'text/plain',
  ) {
    const response = await request(app!.getHttpServer())
      .post('/files')
      .attach('file', content, { filename, contentType })
      .expect(201);
    const fileId = response.body.id as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/u);
    fileIds.push(fileId);
    return response.body as {
      id: string;
      originalName: string;
      sizeBytes: string;
      contentHash: string;
    };
  }

  async function processFile(fileId: string) {
    const response = await request(app!.getHttpServer())
      .post(`/files/${fileId}/process`)
      .expect(202);
    const { jobId, statusUrl } = response.body as {
      jobId: string;
      statusUrl: string;
    };
    expect(statusUrl).toBe(`/files/${fileId}/processing-jobs/${jobId}`);
    return waitForJob(jobId, statusUrl);
  }

  async function waitForJob(jobId: string, statusUrl: string) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await request(app!.getHttpServer())
        .get(statusUrl)
        .expect(200);
      const body = status.body as JobStatus;
      if (body.state === 'completed' || body.state === 'failed')
        return { jobId, ...body };
      await delay(50);
    }
    throw new Error('Timed out waiting for the isolated processing job');
  }

  it('serves the health endpoint', async () => {
    const result = await request(app!.getHttpServer())
      .get('/health')
      .expect(200);
    expect(result.body).toEqual({ status: 'ok', service: 'filemind-api' });
  });

  it('reports live progress and keeps terminal history after Redis removes the job', async () => {
    const file = await upload(
      await readFile(new URL('./fixtures/two-pages.pdf', import.meta.url)),
      'progress-check.pdf',
      'application/pdf',
    );
    await queue!.pause();
    const response = await request(app!.getHttpServer())
      .post(`/files/${file.id}/process`)
      .expect(202)
      .catch(async (error) => {
        await queue!.resume();
        throw error;
      });
    const { jobId, statusUrl } = response.body as {
      jobId: string;
      statusUrl: string;
    };
    try {
      const list = await request(app!.getHttpServer())
        .get('/files')
        .query({ name: 'progress-check.pdf' })
        .expect(200);
      const detail = await request(app!.getHttpServer())
        .get(`/files/${file.id}`)
        .expect(200);
      for (const record of [list.body.items[0], detail.body]) {
        expect(record.processingJob.jobId).toBe(jobId);
        expect(['waiting', 'paused']).toContain(record.processingJob.state);
      }
    } finally {
      await queue!.resume();
    }
    expect(await waitForJob(jobId, statusUrl)).toMatchObject({
      state: 'completed',
      phase: 'indexing',
    });
    await vi.waitFor(
      async () => {
        const history = await request(app!.getHttpServer())
          .get(`/files/${file.id}/processing-jobs`)
          .query({ limit: 1 })
          .expect(200);
        expect(history.body).toMatchObject({
          items: [
            {
              jobId,
              state: 'completed',
              phase: 'indexing',
              finishedAt: expect.any(String),
            },
          ],
          page: 1,
          limit: 1,
          hasMore: false,
        });
      },
      { timeout: 5000 },
    );
    const redisJob = await queue!.getJob(jobId);
    expect(redisJob).toBeDefined();
    await redisJob!.remove();

    const archived = await request(app!.getHttpServer())
      .get(statusUrl)
      .expect(200);
    expect(archived.body).toMatchObject({
      jobId,
      state: 'completed',
      phase: 'indexing',
      result: { chunkCount: expect.any(Number) },
    });
    const detail = await request(app!.getHttpServer())
      .get(`/files/${file.id}`)
      .expect(200);
    expect(detail.body.processingJob).toEqual({ jobId, state: 'completed' });
  }, 30000);

  it('finds byte-identical uploads across filenames, paginates and excludes deleted copies', async () => {
    const bytes = Buffer.from('Exact content for duplicate detection.\r\n');
    const source = await upload(bytes, 'duplicate-source.txt');
    const copies = await Promise.all([
      upload(bytes, 'renamed-copy.md'),
      upload(bytes, '另一份副本.txt'),
      upload(bytes, 'duplicate-source.txt'),
    ]);
    const different = await upload(
      Buffer.from('Exact content for duplicate detection.\n'),
      'duplicate-source.txt',
    );
    expect(source.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      copies.every((file) => file.contentHash === source.contentHash),
    ).toBe(true);
    expect(different.contentHash).not.toBe(source.contentHash);
    expect(new Set([source.id, ...copies.map((file) => file.id)]).size).toBe(4);
    const detail = await request(app!.getHttpServer())
      .get(`/files/${source.id}`)
      .expect(200);
    expect(detail.body.contentHash).toBe(source.contentHash);
    const list = await request(app!.getHttpServer()).get('/files').expect(200);
    expect(
      list.body.items.find((file: { id: string }) => file.id === source.id)
        .contentHash,
    ).toBe(source.contentHash);

    const first = await request(app!.getHttpServer())
      .get(`/files/${source.id.toUpperCase()}/duplicates`)
      .query({ page: 1, limit: 2 })
      .expect(200);
    expect(first.body).toMatchObject({
      fileId: source.id,
      algorithm: 'sha256',
      contentHash: source.contentHash,
      total: 3,
      page: 1,
      limit: 2,
      totalPages: 2,
    });
    expect(first.body.items).toHaveLength(2);
    const second = await request(app!.getHttpServer())
      .get(`/files/${source.id}/duplicates`)
      .query({ page: 2, limit: 2 })
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    const found = [...first.body.items, ...second.body.items].map(
      (file: { id: string }) => file.id,
    );
    expect([...found].sort()).toEqual(copies.map((file) => file.id).sort());
    const beyond = await request(app!.getHttpServer())
      .get(`/files/${source.id}/duplicates`)
      .query({ page: 3, limit: 2 })
      .expect(200);
    expect(beyond.body.items).toEqual([]);

    for (const query of [
      { page: 0 },
      { limit: 101 },
      { limit: 'invalid' },
      { name: 'unused' },
    ])
      await request(app!.getHttpServer())
        .get(`/files/${source.id}/duplicates`)
        .query(query)
        .expect(400);
    await request(app!.getHttpServer())
      .get('/files/invalid/duplicates')
      .expect(400);
    await request(app!.getHttpServer())
      .get(`/files/${randomUUID()}/duplicates`)
      .expect(404);

    await request(app!.getHttpServer())
      .delete(`/files/${copies[0].id}`)
      .expect(204);
    await prisma!.file.update({
      where: { id: copies[1].id },
      data: { deletedAt: new Date() },
    });
    const remaining = await request(app!.getHttpServer())
      .get(`/files/${source.id}/duplicates`)
      .expect(200);
    expect(remaining.body.total).toBe(1);
    expect(remaining.body.items[0].id).toBe(copies[2].id);
    const download = await request(app!.getHttpServer())
      .get(`/files/${copies[2].id}/download`)
      .expect(200);
    expect(download.text).toBe(bytes.toString());
    await request(app!.getHttpServer())
      .delete(`/files/${source.id}`)
      .expect(204);
    await request(app!.getHttpServer())
      .get(`/files/${source.id}/duplicates`)
      .expect(404);
  }, 30000);

  it('backfills unknown hashes, reports unavailable originals and safely resumes', async () => {
    const bytes = Buffer.from('Legacy content for streamed hash backfill.');
    const first = await upload(bytes, 'legacy-first.txt');
    const second = await upload(bytes, 'legacy-second.txt');
    const known = await upload(
      Buffer.from('Already hashed content.'),
      'known.txt',
    );
    const hidden = await upload(
      Buffer.from('Hidden legacy content.'),
      'legacy-hidden.txt',
    );
    const missingBytes = Buffer.from('Temporarily unavailable legacy content.');
    const missing = await upload(missingBytes, 'legacy-missing.txt');
    await prisma!.file.updateMany({
      where: { id: { in: [first.id, second.id, missing.id] } },
      data: { contentHash: null },
    });
    await prisma!.file.update({
      where: { id: hidden.id },
      data: { contentHash: null, deletedAt: new Date() },
    });
    const storage = app!.get(StorageService);
    const missingRow = await prisma!.file.findUniqueOrThrow({
      where: { id: missing.id },
    });
    await storage.remove(missingRow.storageKey!);
    const unknown = await request(app!.getHttpServer())
      .get(`/files/${first.id}/duplicates`)
      .expect(409);
    expect(unknown.body.code).toBe('FILE_HASH_UNAVAILABLE');
    const before = await prisma!.file.findUniqueOrThrow({
      where: { id: first.id },
    });
    const open = vi.spyOn(storage, 'openReadStream');
    const warning = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = new FileHashBackfillService(prisma!, storage);
    try {
      expect(await service.run()).toEqual({
        scanned: 3,
        updated: 2,
        skipped: 0,
        unavailable: 1,
        failed: 0,
      });
      expect(open).toHaveBeenCalledTimes(3);
      const unchanged = await prisma!.file.findUniqueOrThrow({
        where: { id: known.id },
      });
      expect(unchanged.contentHash).toBe(known.contentHash);
      const excluded = await prisma!.file.findUniqueOrThrow({
        where: { id: hidden.id },
      });
      expect(excluded.contentHash).toBeNull();
      const after = await prisma!.file.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(after.contentHash).toBe(first.contentHash);
      expect(after.indexStatus).toBe(before.indexStatus);
      expect(after.indexJobId).toBe(before.indexJobId);
      expect(after.indexedAt).toEqual(before.indexedAt);
      const duplicates = await request(app!.getHttpServer())
        .get(`/files/${first.id}/duplicates`)
        .expect(200);
      expect(duplicates.body.total).toBe(1);
      expect(duplicates.body.items[0].id).toBe(second.id);
      const restoredKey = await storage.save(missingBytes);
      await prisma!.file.update({
        where: { id: missing.id },
        data: { storageKey: restoredKey },
      });
      expect(await service.run()).toEqual({
        scanned: 1,
        updated: 1,
        skipped: 0,
        unavailable: 0,
        failed: 0,
      });
      expect(await service.run()).toEqual({
        scanned: 0,
        updated: 0,
        skipped: 0,
        unavailable: 0,
        failed: 0,
      });
    } finally {
      open.mockRestore();
      warning.mockRestore();
    }
  }, 30000);

  it('does not write a legacy hash when deletion starts while the content is being read', async () => {
    const file = await upload(
      Buffer.from('Hashing and deletion race.'),
      'hash-race.txt',
    );
    await prisma!.file.update({
      where: { id: file.id },
      data: { contentHash: null },
    });
    const storage = app!.get(StorageService);
    const original = storage.openReadStream.bind(storage);
    const open = vi
      .spyOn(storage, 'openReadStream')
      .mockImplementationOnce(async (key) => {
        await prisma!.file.update({
          where: { id: file.id },
          data: { deletedAt: new Date() },
        });
        return original(key);
      });
    try {
      expect(await new FileHashBackfillService(prisma!, storage).run()).toEqual(
        {
          scanned: 1,
          updated: 0,
          skipped: 1,
          unavailable: 0,
          failed: 0,
        },
      );
      const record = await prisma!.file.findUniqueOrThrow({
        where: { id: file.id },
      });
      expect(record.contentHash).toBeNull();
      expect(record.deletedAt).toBeInstanceOf(Date);
    } finally {
      open.mockRestore();
    }
  }, 30000);

  it.each([
    {},
    { q: ' ' },
    { q: 'x', page: 0 },
    { q: 'x', fileId: 'invalid' },
    { q: 'x', unexpected: 'value' },
  ])(
    'validates search parameters through the production pipe: %j',
    async (query) => {
      await request(app!.getHttpServer())
        .get('/search')
        .query(query)
        .expect(400);
    },
  );

  it('uploads, downloads, processes, searches and safely reprocesses a real file', async () => {
    const text =
      '100x aXb unrelated\n' +
      '🙂向量检索 100% a_b C:\\notes\\file.md\n'.repeat(40);
    const file = await upload(Buffer.from(text));
    expect(file.sizeBytes).toBe(String(Buffer.byteLength(text)));

    const download = await request(app!.getHttpServer())
      .get(`/files/${file.id}/download`)
      .expect(200);
    expect(download.text).toBe(text);
    const unprocessed = await request(app!.getHttpServer())
      .get('/search')
      .query({ q: '向量', fileId: file.id })
      .expect(200);
    expect(unprocessed.body.total).toBe(0);

    const first = await processFile(file.id);
    expect(first.state).toBe('completed');
    const chunksResponse = await request(app!.getHttpServer())
      .get(`/files/${file.id}/chunks`)
      .query({ limit: 100 })
      .expect(200);
    const chunks = chunksResponse.body.items as Chunk[];
    expect(chunks.length).toBeGreaterThan(1);
    expect(first.result?.chunkCount).toBe(chunks.length);
    for (const chunk of chunks) {
      expect(
        Array.from(text).slice(chunk.startOffset, chunk.endOffset).join(''),
      ).toBe(chunk.content);
    }

    const vectorPath = `/files/${file.id}/chunks/${chunks[0].id}/vector`;
    const previousEmbeddingCalls = embeddingStub.embed.mock.calls.length;
    const stored = await request(app!.getHttpServer())
      .get(vectorPath)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    const dimensions = realEmbeddings
      ? Number(process.env.EMBEDDING_DIMENSIONS)
      : 3;
    expect(stored.body).toMatchObject({
      fileId: file.id,
      chunkId: chunks[0].id,
      index: chunks[0].index,
      collection,
      model: realEmbeddings ? process.env.EMBEDDING_MODEL : FIXTURE_MODEL,
      dimensions,
    });
    expect(stored.body.vector).toHaveLength(dimensions);
    if (!realEmbeddings) expect(stored.body.vector).toEqual([0, 0, 1]);
    expect(embeddingStub.embed.mock.calls).toHaveLength(previousEmbeddingCalls);
    await request(app!.getHttpServer())
      .get(`/files/${randomUUID()}/chunks/${chunks[0].id}/vector`)
      .expect(404);

    for (const q of ['向量', '100%', 'a_b', 'C:\\notes\\file.md']) {
      const search = await request(app!.getHttpServer())
        .get('/search')
        .query({ q, fileId: file.id, limit: 100 })
        .expect(200);
      const expected = chunks.filter((chunk) => chunk.content.includes(q));
      expect(search.body).toMatchObject({
        query: q,
        mode: 'literal',
        caseSensitive: true,
        offsetUnit: 'unicode-code-point',
        total: expected.length,
      });
      expect(
        search.body.items.map((item: { chunkId: string }) => item.chunkId),
      ).toEqual(expected.map((chunk) => chunk.id));
      for (const item of search.body.items) {
        expect(item.matches.length).toBeGreaterThan(0);
        for (const match of item.matches) {
          expect(
            Array.from(item.content as string)
              .slice(match.start, match.end)
              .join(''),
          ).toBe(q);
        }
      }
    }

    const page = await request(app!.getHttpServer())
      .get('/search')
      .query({ q: '向量', fileId: file.id, limit: 1, page: 2 })
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.totalPages).toBe(chunks.length);
    expect(page.body.items[0].chunkId).toBe(chunks[1].id);

    const noMatch = await request(app!.getHttpServer())
      .get('/search')
      .query({ q: 'FILE.md', fileId: file.id })
      .expect(200);
    expect(noMatch.body.items).toEqual([]);

    const second = await processFile(file.id);
    expect(second.state).toBe('completed');
    expect(second.jobId).not.toBe(first.jobId);
    const repeated = await request(app!.getHttpServer())
      .get(`/files/${file.id}/chunks`)
      .query({ limit: 100 })
      .expect(200);
    expect(repeated.body.total).toBe(chunks.length);
    const contentAndOffsets = ({
      index,
      content,
      startOffset,
      endOffset,
    }: Chunk) => ({ index, content, startOffset, endOffset });
    expect(repeated.body.items.map(contentAndOffsets)).toEqual(
      chunks.map(contentAndOffsets),
    );
  }, 120000);

  it.each([
    {},
    { q: ' ' },
    { q: 'x', limit: 0 },
    { q: 'x', fileId: 'invalid' },
    { q: 'x', page: 1 },
  ])('validates semantic query parameters: %j', async (query) => {
    await request(app!.getHttpServer())
      .get('/search/semantic')
      .query(query)
      .expect(400);
  });

  it(
    realEmbeddings
      ? 'retrieves a Chinese passage for an English query using the real embedding provider'
      : 'returns provider-ranked chunks and enforces file filtering with controlled test vectors',
    async () => {
      const weatherText = '天气预报说明天会下雨，出门时请带一把雨伞。';
      const databaseText = '数据库索引可以加速查询，避免扫描整张数据表。';
      if (!realEmbeddings) {
        const responses = new Map<string, number[]>([
          [weatherText, [1, 0, 0]],
          [databaseText, [0, 1, 0]],
          ['rainy weather', [1, 0, 0]],
        ]);
        embeddingStub.embed.mockImplementation(async (texts) => ({
          model: FIXTURE_MODEL,
          dimensions: 3,
          vectors: texts.map((text) => {
            const vector = responses.get(text);
            if (!vector)
              throw new Error('Unexpected embedding input in retrieval test');
            return [...vector];
          }),
        }));
      }
      const weather = await upload(Buffer.from(weatherText), 'weather.txt');
      const database = await upload(Buffer.from(databaseText), 'database.md');
      const before = await request(app!.getHttpServer())
        .get('/search/semantic')
        .query({ q: 'rainy weather', fileId: weather.id })
        .expect(200);
      expect(before.body.items).toEqual([]);
      for (const file of [weather, database])
        expect((await processFile(file.id)).state).toBe('completed');

      const literal = await request(app!.getHttpServer())
        .get('/search')
        .query({ q: 'rainy weather', fileId: weather.id })
        .expect(200);
      expect(literal.body.items).toEqual([]);
      const semantic = await request(app!.getHttpServer())
        .get('/search/semantic')
        .query({ q: 'rainy weather', limit: 2 })
        .expect(200);
      expect(semantic.body.mode).toBe('semantic');
      expect(semantic.body.items[0].file.id).toBe(weather.id);
      expect(semantic.body.items[0].content).toContain('雨伞');
      expect(semantic.body.items[0].score).toEqual(expect.any(Number));
      const scoped = await request(app!.getHttpServer())
        .get('/search/semantic')
        .query({ q: 'rainy weather', fileId: database.id })
        .expect(200);
      expect(scoped.body.items).toHaveLength(1);
      expect(
        scoped.body.items.every(
          (item: { file: { id: string } }) => item.file.id === database.id,
        ),
      ).toBe(true);
      const metadata = await request(app!.getHttpServer())
        .get(`/files/${weather.id}`)
        .expect(200);
      expect(metadata.body.indexStatus).toBe('READY');
      expect(metadata.body.indexedAt).toEqual(expect.any(String));

      await prisma!.file.update({
        where: { id: weather.id },
        data: { indexStatus: 'FAILED' },
      });
      const hidden = await request(app!.getHttpServer())
        .get('/search/semantic')
        .query({ q: 'rainy weather', limit: 2 })
        .expect(200);
      expect(
        hidden.body.items.some(
          (item: { file: { id: string } }) => item.file.id === weather.id,
        ),
      ).toBe(false);
      expect((await processFile(weather.id)).state).toBe('completed');
    },
    120000,
  );

  it('reports invalid UTF-8 as a terminal job failure', async () => {
    const file = await upload(Buffer.from([0xff, 0xfe, 0x80]));
    const job = await processFile(file.id);
    expect(job).toMatchObject({
      state: 'failed',
      attemptsMade: 1,
      result: null,
    });
    expect(job.error).toEqual(expect.any(String));
    const chunks = await request(app!.getHttpServer())
      .get(`/files/${file.id}/chunks`)
      .expect(200);
    expect(chunks.body.total).toBe(0);
  }, 15000);

  it.each([
    {
      filename: 'two-pages.pdf',
      mime: 'application/pdf',
      source: { format: 'pdf', page: 2 },
    },
    {
      filename: 'paragraphs.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      source: { format: 'docx', paragraphStart: 1, paragraphEnd: 3 },
    },
  ])(
    'indexes, locates and reprocesses actual document bytes: $filename',
    async ({ filename, mime, source }) => {
      const bytes = await readFile(
        new URL(`./fixtures/${filename}`, import.meta.url),
      );
      const file = await upload(bytes, filename, mime);
      const processed = await processFile(file.id);
      expect(processed.state).toBe('completed');
      const response = await request(app!.getHttpServer())
        .get(`/files/${file.id}/chunks`)
        .expect(200);
      const chunks = response.body.items as Chunk[];
      expect(chunks.length).toBe(filename.endsWith('.pdf') ? 2 : 1);
      expect(
        chunks.every((chunk) => chunk.source?.format === source.format),
      ).toBe(true);
      const literal = await request(app!.getHttpServer())
        .get('/search')
        .query({ q: '数据库索引', fileId: file.id })
        .expect(200);
      expect(literal.body.items).toHaveLength(1);
      expect(literal.body.items[0].source).toEqual(source);
      for (const match of literal.body.items[0].matches)
        expect(
          Array.from(literal.body.items[0].content as string)
            .slice(match.start, match.end)
            .join(''),
        ).toBe('数据库索引');
      const semantic = await request(app!.getHttpServer())
        .get('/search/semantic')
        .query({ q: '文件查询', fileId: file.id, limit: 10 })
        .expect(200);
      expect(semantic.body.returned).toBe(chunks.length);
      for (const item of semantic.body.items) {
        const original = chunks.find((chunk) => chunk.id === item.chunkId);
        expect(original).toBeDefined();
        expect(item.source).toEqual(original!.source);
        expect(item.content).toBe(original!.content);
      }
      expect((await processFile(file.id)).state).toBe('completed');
      const repeated = await request(app!.getHttpServer())
        .get(`/files/${file.id}/chunks`)
        .expect(200);
      expect(repeated.body.items.map((chunk: Chunk) => chunk.id)).toEqual(
        chunks.map((chunk) => chunk.id),
      );
      expect(repeated.body.items.map((chunk: Chunk) => chunk.source)).toEqual(
        chunks.map((chunk) => chunk.source),
      );
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(204);
      expect(
        await prisma!.fileChunk.count({ where: { fileId: file.id } }),
      ).toBe(0);
    },
    120000,
  );

  it.each(['broken.pdf', 'broken.docx', 'empty.pdf', 'empty.docx'])(
    'stops invalid or textless document jobs without calling embeddings: %s',
    async (filename) => {
      const bytes = filename.startsWith('empty')
        ? await readFile(new URL(`./fixtures/${filename}`, import.meta.url))
        : Buffer.from('not a valid document');
      const file = await upload(bytes, filename);
      const job = await processFile(file.id);
      expect(job).toMatchObject({
        state: 'failed',
        attemptsMade: 1,
        result: null,
      });
      expect(embeddingStub.embed).not.toHaveBeenCalled();
      const detail = await request(app!.getHttpServer())
        .get(`/files/${file.id}`)
        .expect(200);
      expect(detail.body.indexStatus).toBe('FAILED');
      expect(
        await prisma!.fileChunk.count({ where: { fileId: file.id } }),
      ).toBe(0);
    },
    15000,
  );

  it('deletes original content, chunks and current/historical vectors, and can be repeated', async () => {
    const file = await upload(
      Buffer.from('Temporary content for deletion verification.'),
      'delete-me.txt',
    );
    const job = await processFile(file.id);
    expect(job.state).toBe('completed');
    const record = await prisma!.file.findUniqueOrThrow({
      where: { id: file.id },
      select: { storageKey: true },
    });
    const oldCollection = `filemind_history_${randomUUID().replaceAll('-', '')}`;
    let historical: VectorStoreService | undefined;
    try {
      if (realVectors) {
        const existing = await cleanupClient!.hasCollection({
          collection_name: oldCollection,
        });
        assertMilvusSuccess(existing.status);
        expect(existing.value).toBe(false);
        ownedCollections.add(oldCollection);
        const config = app!.get(ConfigService);
        historical = new VectorStoreService(
          new ConfigService({
            MILVUS_ADDRESS: config.get<string>('MILVUS_ADDRESS'),
            MILVUS_TOKEN: config.get<string>('MILVUS_TOKEN'),
            MILVUS_COLLECTION: oldCollection,
            EMBEDDING_MODEL: 'historical-test-model',
            EMBEDDING_DIMENSIONS: '5',
          }),
        );
        await historical.upsert([
          {
            chunkId: randomUUID(),
            fileId: file.id,
            index: 0,
            vector: [1, 0, 0, 0, 0],
          },
        ]);
      }
      await prisma!.fileVectorIndex.create({
        data: { fileId: file.id, collection: oldCollection },
      });
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(204);
      expect(
        await prisma!.file.findUnique({ where: { id: file.id } }),
      ).toBeNull();
      expect(
        await prisma!.fileChunk.count({ where: { fileId: file.id } }),
      ).toBe(0);
      expect(
        await prisma!.fileVectorIndex.count({ where: { fileId: file.id } }),
      ).toBe(0);
      await expect(
        app!.get(StorageService).read(record.storageKey!),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const dimensions = Number(
        app!.get(ConfigService).get('EMBEDDING_DIMENSIONS'),
      );
      const probe = Array.from({ length: dimensions }, (_, index) =>
        index === 0 ? 1 : 0,
      );
      expect(
        await app!.get(VectorStoreService).search(probe, { fileId: file.id }),
      ).toEqual([]);
      if (historical)
        expect(
          await historical.search([1, 0, 0, 0, 0], { fileId: file.id }),
        ).toEqual([]);
      for (const path of [
        `/files/${file.id}`,
        `/files/${file.id}/download`,
        `/files/${file.id}/chunks`,
        `/files/${file.id}/processing-jobs/${job.jobId}`,
      ]) {
        await request(app!.getHttpServer()).get(path).expect(404);
      }
      await request(app!.getHttpServer())
        .post(`/files/${file.id}/process`)
        .expect(404);
      const literal = await request(app!.getHttpServer())
        .get('/search')
        .query({ q: 'Temporary', fileId: file.id })
        .expect(200);
      expect(literal.body.items).toEqual([]);
      const semantic = await request(app!.getHttpServer())
        .get('/search/semantic')
        .query({ q: 'Temporary', fileId: file.id })
        .expect(200);
      expect(semantic.body.items).toEqual([]);
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(204);
    } finally {
      await historical?.onModuleDestroy();
    }
  }, 120000);

  it('hides incomplete deletions and completes them on a repeated DELETE', async () => {
    const file = await upload(
      Buffer.from('Deletion recovery test.'),
      'delete-retry.txt',
    );
    const storage = app!.get(StorageService);
    const failureLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const remove = vi
      .spyOn(storage, 'remove')
      .mockRejectedValueOnce(new Error('Injected disk failure'));
    try {
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(503);
      expect(failureLog).toHaveBeenCalledWith(
        `File deletion failed for ${file.id}`,
        expect.stringContaining('Injected disk failure'),
      );
      const record = await prisma!.file.findUniqueOrThrow({
        where: { id: file.id },
      });
      expect(record.deletedAt).toBeInstanceOf(Date);
      expect(await storage.read(record.storageKey!)).toEqual(
        Buffer.from('Deletion recovery test.'),
      );
      await request(app!.getHttpServer()).get(`/files/${file.id}`).expect(404);
      await request(app!.getHttpServer())
        .get(`/files/${file.id}/download`)
        .expect(404);
      await request(app!.getHttpServer())
        .get(`/files/${file.id}/chunks`)
        .expect(404);
      await request(app!.getHttpServer())
        .post(`/files/${file.id}/process`)
        .expect(404);
      const list = await request(app!.getHttpServer())
        .get('/files')
        .expect(200);
      expect(
        list.body.items.some((item: { id: string }) => item.id === file.id),
      ).toBe(false);
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(204);
      expect(
        await prisma!.file.findUnique({ where: { id: file.id } }),
      ).toBeNull();
      await expect(storage.read(record.storageKey!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      remove.mockRestore();
      failureLog.mockRestore();
    }
  }, 30000);

  it('rejects deletion while a worker writes vectors and succeeds after indexing finishes', async () => {
    const file = await upload(
      Buffer.from('Concurrent indexing and deletion verification.'),
      'delete-active.txt',
    );
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const store = worker!.get(VectorStoreService);
    const original = store.upsert.bind(store);
    const upsert = vi
      .spyOn(store, 'upsert')
      .mockImplementationOnce(async (rows) => {
        entered();
        await gate;
        return original(rows);
      });
    const processing = processFile(file.id);
    try {
      await Promise.race([
        writing,
        processing.then(() => {
          throw new Error('Worker finished before the write gate');
        }),
      ]);
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(409);
      const untouched = await prisma!.file.findUniqueOrThrow({
        where: { id: file.id },
      });
      expect(untouched.deletedAt).toBeNull();
      expect(untouched.indexStatus).toBe('PROCESSING');
      release();
      expect((await processing).state).toBe('completed');
      await request(app!.getHttpServer())
        .delete(`/files/${file.id}`)
        .expect(204);
    } finally {
      release();
      await processing.catch(() => undefined);
      upsert.mockRestore();
    }
  }, 120000);

  it.runIf(!realEmbeddings)(
    'does not recreate a file deleted while its model request was in flight',
    async () => {
      const file = await upload(
        Buffer.from('Deletion during an in-flight embedding request.'),
        'delete-preflight.txt',
      );
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const embedding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      embeddingStub.embed.mockImplementationOnce(async (texts) => {
        entered();
        await gate;
        return {
          model: FIXTURE_MODEL,
          dimensions: 3,
          vectors: texts.map(() => [1, 0, 0]),
        };
      });
      const queued = await request(app!.getHttpServer())
        .post(`/files/${file.id}/process`)
        .expect(202);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          embedding,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error('Worker did not reach the embedding gate')),
              10000,
            );
          }),
        ]);
        await request(app!.getHttpServer())
          .delete(`/files/${file.id}`)
          .expect(204);
      } finally {
        clearTimeout(timeout);
        release();
      }
      const deadline = Date.now() + 10000;
      let state: string | undefined;
      while (Date.now() < deadline) {
        const job = await queue!.getJob(queued.body.jobId as string);
        state = await job?.getState();
        if (state === 'failed' || state === 'completed') break;
        await delay(50);
      }
      expect(state).toBe('failed');
      expect(
        await prisma!.file.findUnique({ where: { id: file.id } }),
      ).toBeNull();
      expect(
        await prisma!.fileChunk.count({ where: { fileId: file.id } }),
      ).toBe(0);
      expect(
        await app!
          .get(VectorStoreService)
          .search([1, 0, 0], { fileId: file.id }),
      ).toEqual([]);
    },
    30000,
  );
});
