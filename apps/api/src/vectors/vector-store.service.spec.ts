import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { VectorStoreError } from './vector-store-error.js';
import { VectorStoreService } from './vector-store.service.js';

const sdk = vi.hoisted(() => ({
  construct: vi.fn(),
  client: {
    connectPromise: Promise.resolve(),
    hasCollection: vi.fn(),
    createCollection: vi.fn(),
    describeCollection: vi.fn(),
    createIndex: vi.fn(),
    loadCollection: vi.fn(),
    upsert: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    closeConnection: vi.fn(),
  },
}));

vi.mock('@zilliz/milvus2-sdk-node', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@zilliz/milvus2-sdk-node')>();
  return {
    ...actual,
    MilvusClient: vi.fn(function (this: object, options: unknown) {
      sdk.construct(options);
      Object.assign(this, sdk.client);
    }),
  };
});

const success = { error_code: 'Success', code: 0 };
const settings = {
  EMBEDDING_MODEL: 'fixture-model',
  EMBEDDING_DIMENSIONS: '3',
};
const fileId = '11111111-1111-4111-8111-111111111111';
const chunkId = '22222222-2222-4222-8222-222222222222';
const chunk = { chunkId, fileId, index: 0, vector: [1, 0, 0] };

function description() {
  return {
    status: success,
    consistency_level: 'Strong',
    schema: {
      description: JSON.stringify({
        application: 'filemind',
        schemaVersion: 1,
        model: 'fixture-model',
        dimensions: 3,
      }),
      autoID: false,
      fields: [
        {
          name: 'chunk_id',
          data_type: 'VarChar',
          is_primary_key: true,
          autoID: false,
          type_params: [{ key: 'max_length', value: '36' }],
        },
        {
          name: 'file_id',
          data_type: 'VarChar',
          type_params: [{ key: 'max_length', value: '36' }],
        },
        { name: 'chunk_index', data_type: 'Int32', type_params: [] },
        {
          name: 'embedding',
          data_type: 'FloatVector',
          type_params: [{ key: 'dim', value: '3' }],
        },
      ],
    },
  };
}

describe('VectorStoreService', () => {
  let instances: VectorStoreService[];
  const service = (overrides: Record<string, string> = {}) => {
    const instance = new VectorStoreService(
      new ConfigService({ ...settings, ...overrides }),
    );
    instances.push(instance);
    return instance;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    instances = [];
    sdk.client.connectPromise = Promise.resolve();
    sdk.client.hasCollection.mockResolvedValue({
      status: success,
      value: false,
    });
    sdk.client.createCollection.mockResolvedValue(success);
    sdk.client.describeCollection.mockImplementation(async () => description());
    sdk.client.createIndex.mockResolvedValue(success);
    sdk.client.loadCollection.mockResolvedValue(success);
    sdk.client.upsert.mockImplementation(
      async ({ data }: { data: unknown[] }) => ({
        status: success,
        upsert_cnt: String(data.length),
        err_index: [],
      }),
    );
    sdk.client.search.mockResolvedValue({ status: success, results: [] });
    sdk.client.delete.mockResolvedValue({ status: success });
    sdk.client.closeConnection.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.onModuleDestroy()));
    vi.useRealTimers();
  });

  it('does not connect or require model settings until first use', async () => {
    const instance = new VectorStoreService(new ConfigService());
    await instance.onModuleDestroy();
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it('creates a UUID-based schema with a cosine index and shares initialization', async () => {
    const instance = service();
    const [first, second] = await Promise.all([
      instance.ensureCollection(),
      instance.ensureCollection(),
    ]);
    expect(first).toEqual({
      collection: 'filemind_chunks_v1',
      model: 'fixture-model',
      dimensions: 3,
    });
    expect(second).toEqual(first);
    expect(sdk.construct).toHaveBeenCalledOnce();
    expect(sdk.construct).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 10000,
        maxRetries: 0,
        telemetry: { enabled: false },
      }),
    );
    expect(sdk.client.createCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        enable_dynamic_field: false,
        consistency_level: 'Strong',
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'chunk_id',
            is_primary_key: true,
            autoID: false,
          }),
        ]),
      }),
    );
    expect(sdk.client.createIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index_type: 'HNSW', metric_type: 'COSINE' }),
    );
    expect(sdk.client.loadCollection).toHaveBeenCalledOnce();
  });

  it('validates and reuses an existing collection', async () => {
    sdk.client.hasCollection.mockResolvedValue({
      status: success,
      value: true,
    });
    await service().ensureCollection();
    expect(sdk.client.createCollection).not.toHaveBeenCalled();
    expect(sdk.client.describeCollection).toHaveBeenCalledWith({
      collection_name: 'filemind_chunks_v1',
      cache: false,
    });
  });

  it('checks a collection created concurrently by another process', async () => {
    sdk.client.createCollection.mockResolvedValue({
      error_code: 'UnexpectedError',
      code: 65535,
    });
    sdk.client.hasCollection
      .mockResolvedValueOnce({ status: success, value: false })
      .mockResolvedValueOnce({ status: success, value: true });
    await expect(service().ensureCollection()).resolves.toMatchObject({
      dimensions: 3,
    });
    expect(sdk.client.describeCollection).toHaveBeenCalledOnce();
  });

  it.each([
    'model',
    'dimension',
    'primary',
    'type',
    'length',
    'nullable',
    'missing-length',
    'consistency',
  ])(
    'refuses an incompatible %s without changing existing data',
    async (change) => {
      const result = description();
      if (change === 'model') result.schema.description = 'another model';
      if (change === 'dimension')
        result.schema.fields[3].type_params[0].value = '4';
      if (change === 'primary') result.schema.fields[0].autoID = true;
      if (change === 'type') result.schema.fields[2].data_type = 'VarChar';
      if (change === 'length')
        result.schema.fields[1].type_params[0].value = '10';
      if (change === 'nullable')
        Object.assign(result.schema.fields[1], { nullable: true });
      if (change === 'missing-length') result.schema.fields[1].type_params = [];
      if (change === 'consistency') result.consistency_level = 'Bounded';
      sdk.client.describeCollection.mockResolvedValue(result);
      await expect(service().ensureCollection()).rejects.toMatchObject({
        code: 'schema_mismatch',
        retryable: false,
      });
      expect(sdk.client.createIndex).not.toHaveBeenCalled();
      expect(sdk.client.upsert).not.toHaveBeenCalled();
    },
  );

  it('uses upsert rather than delete-and-insert and batches without losing IDs', async () => {
    const chunks = Array.from({ length: 129 }, (_, index) => ({
      ...chunk,
      chunkId: randomUUID(),
      index,
    }));
    await expect(service().upsert(chunks)).resolves.toEqual({ count: 129 });
    expect(
      sdk.client.upsert.mock.calls.map(([request]) => request.data.length),
    ).toEqual([128, 1]);
    expect(sdk.client.upsert.mock.calls[0][0].data[0]).toEqual({
      chunk_id: chunks[0].chunkId,
      file_id: fileId,
      chunk_index: 0,
      embedding: [1, 0, 0],
    });
    expect(sdk.client.delete).not.toHaveBeenCalled();
  });

  it('handles an empty write without connecting', async () => {
    await expect(service().upsert([])).resolves.toEqual({ count: 0 });
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it.each([
    { ...chunk, vector: [1, 0] },
    { ...chunk, vector: [0, 0, 0] },
    { ...chunk, vector: [NaN, 1, 0] },
    { ...chunk, vector: [Infinity, 1, 0] },
    { ...chunk, vector: [1e100, 0, 0] },
    { ...chunk, vector: [1e-100, 0, 0] },
    { ...chunk, vector: Object.assign([1], { length: 3 }) },
    { ...chunk, index: -1 },
    { ...chunk, index: 0.5 },
    { ...chunk, index: 2147483648 },
    { ...chunk, chunkId: 'invalid' },
    { ...chunk, fileId: '" or file_id != "' },
  ])('rejects invalid vectors and metadata before writing', async (invalid) => {
    await expect(
      service().upsert([
        chunk,
        {
          ...invalid,
          chunkId: invalid.chunkId === chunkId ? randomUUID() : invalid.chunkId,
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it('rejects duplicate IDs in a write request', async () => {
    await expect(service().upsert([chunk, chunk])).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it.each([
    { status: success, upsert_cnt: '0', err_index: [] },
    { status: success, upsert_cnt: '1', err_index: [0] },
    {
      status: {
        error_code: 'UnexpectedError',
        reason: 'secret connection detail',
      },
      upsert_cnt: '1',
      err_index: [],
    },
  ])(
    'does not report partial or failed writes as success',
    async (response) => {
      sdk.client.upsert.mockResolvedValue(response);
      await expect(service().upsert([chunk])).rejects.toMatchObject({
        code: 'unavailable',
        retryable: true,
      });
    },
  );

  it('keeps similarity ranking and supports a file filter with strong consistency', async () => {
    sdk.client.search.mockResolvedValue({
      status: success,
      results: [
        { chunk_id: chunkId, file_id: fileId, chunk_index: 2, score: 0.91 },
      ],
    });
    await expect(
      service().search([1, 0, 0], { fileId, limit: 7 }),
    ).resolves.toEqual([{ chunkId, fileId, index: 2, score: 0.91 }]);
    expect(sdk.client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: `file_id == "${fileId}"`,
        data: [1, 0, 0],
        limit: 7,
        output_fields: ['chunk_id', 'file_id', 'chunk_index'],
      }),
    );
  });

  it.each([0, -1, 101, 1.5, NaN])(
    'rejects an invalid result limit %s',
    async (limit) => {
      await expect(
        service().search([1, 0, 0], { limit }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(sdk.construct).not.toHaveBeenCalled();
    },
  );

  it.each([
    { chunk_id: 'bad', file_id: fileId, chunk_index: 0, score: 1 },
    { chunk_id: chunkId, file_id: 'bad', chunk_index: 0, score: 1 },
    { chunk_id: chunkId, file_id: fileId, chunk_index: -1, score: 1 },
    { chunk_id: chunkId, file_id: fileId, chunk_index: 0, score: NaN },
    { chunk_id: chunkId, file_id: randomUUID(), chunk_index: 0, score: 1 },
  ])('rejects malformed or cross-file search results', async (row) => {
    sdk.client.search.mockResolvedValue({ status: success, results: [row] });
    await expect(service().search([1, 0, 0], { fileId })).rejects.toMatchObject(
      { code: 'invalid_response' },
    );
  });

  it('deletes only a validated file ID', async () => {
    await service().deleteByFile(fileId);
    expect(sdk.client.delete).toHaveBeenCalledWith({
      collection_name: 'filemind_chunks_v1',
      filter: `file_id == "${fileId}"`,
    });
  });

  it('excludes in-progress files in the server-side search filter', async () => {
    await service().search([1, 0, 0], {
      fileId,
      excludeFileIds: [chunkId, chunkId],
    });
    expect(sdk.client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: `file_id == "${fileId}" and file_id not in ["${chunkId}"]`,
      }),
    );
  });

  it('rejects a filter injection before connecting', async () => {
    await expect(service().deleteByFile('" or true')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it('checks both legacy and modern server error codes', async () => {
    sdk.client.hasCollection.mockResolvedValue({
      status: { error_code: 'Success', code: 42, reason: 'do not disclose' },
      value: true,
    });
    await expect(service().ensureCollection()).rejects.toThrow(
      'Milvus operation failed',
    );
    expect(sdk.client.createIndex).not.toHaveBeenCalled();
  });

  it('allows initialization to retry after a transport failure and closes failed clients', async () => {
    sdk.client.hasCollection.mockRejectedValueOnce(
      new Error('private token and transport details'),
    );
    const instance = service();
    await expect(instance.ensureCollection()).rejects.toThrow(
      'Milvus request failed; verify the server and connection configuration',
    );
    expect(sdk.client.closeConnection).toHaveBeenCalledOnce();
    await expect(instance.ensureCollection()).resolves.toMatchObject({
      dimensions: 3,
    });
    expect(sdk.construct).toHaveBeenCalledTimes(2);
  });

  it('bounds the SDK loading loop and closes the client on timeout', async () => {
    vi.useFakeTimers();
    sdk.client.loadCollection.mockReturnValue(new Promise(() => undefined));
    const promise = service().ensureCollection();
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30001);
    await assertion;
    expect(sdk.client.closeConnection).toHaveBeenCalledOnce();
  });

  it('closes initialized clients and rejects further operations', async () => {
    const instance = service();
    await instance.ensureCollection();
    await instance.onModuleDestroy();
    await expect(instance.ensureCollection()).rejects.toBeInstanceOf(
      VectorStoreError,
    );
    expect(sdk.client.closeConnection).toHaveBeenCalledOnce();
  });
});
