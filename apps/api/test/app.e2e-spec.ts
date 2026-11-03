import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getQueueToken, getSharedConfigToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EmbeddingsService } from '../src/embeddings/embeddings.service.js';
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
}

interface JobStatus {
  state: string;
  attemptsMade: number;
  result: { chunkCount: number } | null;
  error: string | null;
}

describe('File retrieval pipeline (e2e)', () => {
  const prefix = `filemind-e2e-${randomUUID()}`;
  const fileIds: string[] = [];
  const collection = `filemind_pipeline_${randomUUID().replaceAll('-', '')}`;
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
        if (
          cleanupClient &&
          ownsCollection &&
          /^filemind_pipeline_[0-9a-f]{32}$/u.test(collection)
        ) {
          const exists = await cleanupClient.hasCollection({
            collection_name: collection,
          });
          assertMilvusSuccess(exists.status);
          if (exists.value)
            assertMilvusSuccess(
              await cleanupClient.dropCollection({
                collection_name: collection,
              }),
            );
        }
      } finally {
        await cleanupClient?.closeConnection();
        if (storageDirectory) await rmdir(storageDirectory);
      }
    }
  }, 20000);

  async function upload(content: Buffer, filename = 'e2e-notes.txt') {
    const response = await request(app!.getHttpServer())
      .post('/files')
      .attach('file', content, { filename, contentType: 'text/plain' })
      .expect(201);
    const fileId = response.body.id as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/u);
    fileIds.push(fileId);
    return response.body as {
      id: string;
      originalName: string;
      sizeBytes: string;
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
});
