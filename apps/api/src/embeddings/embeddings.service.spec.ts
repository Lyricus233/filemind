import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ConfigService } from '@nestjs/config';

import { EmbeddingError } from './embedding-error.js';
import { EmbeddingsService } from './embeddings.service.js';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
describe('EmbeddingsService', () => {
  const settings = {
    EMBEDDING_BASE_URL: 'https://embeddings.example/v1',
    EMBEDDING_API_KEY: 'test-secret',
    EMBEDDING_MODEL: 'test-model',
    EMBEDDING_DIMENSIONS: '3',
  };
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const service = (overrides: Record<string, string | undefined> = {}) =>
    new EmbeddingsService(new ConfigService({ ...settings, ...overrides }));
  const response = (vectors: number[][]) =>
    Response.json({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    });

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends text unchanged with bearer authentication and the float encoding', async () => {
    fetchMock.mockResolvedValue(response([[0.1, 0.2, 0.3]]));
    await expect(service().embed([' 🙂向量\n '])).resolves.toEqual({
      model: 'test-model',
      dimensions: 3,
      vectors: [[0.1, 0.2, 0.3]],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(requestUrl(url)).toBe(`${settings.EMBEDDING_BASE_URL}/embeddings`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-secret');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'test-model',
      input: [' 🙂向量\n '],
      encoding_format: 'float',
    });
    // Expected dimensions are checked locally; not every provider can resize vectors.
    expect(JSON.parse(init!.body as string)).not.toHaveProperty('dimensions');
  });

  it('normalizes the API base URL without duplicating endpoint paths', async () => {
    fetchMock.mockResolvedValue(response([[1, 0, 0]]));
    await service({
      EMBEDDING_BASE_URL: `${settings.EMBEDDING_BASE_URL}/`,
    }).embed(['a']);
    expect(requestUrl(fetchMock.mock.calls[0][0])).toBe(
      `${settings.EMBEDDING_BASE_URL}/embeddings`,
    );
  });
  it('restores input order using provider indices', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      }),
    );
    expect((await service().embed(['first', 'second'])).vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it('submits sequential batches and preserves their order', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response([
          [1, 0, 0],
          [0, 1, 0],
        ]),
      )
      .mockResolvedValueOnce(response([[0, 0, 1]]));
    const result = await service({ EMBEDDING_BATCH_SIZE: '2' }).embed([
      'a',
      'b',
      'c',
    ]);
    expect(result.vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => JSON.parse(init!.body as string).input,
      ),
    ).toEqual([['a', 'b'], ['c']]);
  });

  it.each([{ texts: [] }, { texts: [''] }, { texts: [' \n '] }])(
    'rejects empty input without a request: %j',
    async ({ texts }) => {
      await expect(service().embed(texts)).rejects.toMatchObject({
        code: 'invalid_input',
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['EMBEDDING_BASE_URL', undefined],
    ['EMBEDDING_BASE_URL', 'not-a-url'],
    ['EMBEDDING_BASE_URL', 'https://embeddings.example/v1/embeddings'],
    ['EMBEDDING_BASE_URL', 'https://embeddings.example/v1/embeddings/'],
    ['EMBEDDING_BASE_URL', 'http://remote.example/embeddings'],
    ['EMBEDDING_BASE_URL', 'https://user:secret@remote.example/embeddings'],
    ['EMBEDDING_BASE_URL', 'https://remote.example/embeddings?key=secret'],
    ['EMBEDDING_API_KEY', ''],
    ['EMBEDDING_API_KEY', 'secret\r\ninjected: header'],
    ['EMBEDDING_MODEL', ''],
    ['EMBEDDING_DIMENSIONS', undefined],
    ['EMBEDDING_DIMENSIONS', '3.5'],
    ['EMBEDDING_DIMENSIONS', '0'],
    ['EMBEDDING_DIMENSIONS', '32769'],
    ['EMBEDDING_BATCH_SIZE', '0'],
    ['EMBEDDING_BATCH_SIZE', '129'],
    ['EMBEDDING_TIMEOUT_MS', 'NaN'],
  ])('rejects invalid %s configuration before sending', async (name, value) => {
    await expect(service({ [name]: value }).embed(['a'])).rejects.toMatchObject(
      {
        code: 'configuration',
        retryable: false,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'authentication', false],
    [403, 'authentication', false],
    [408, 'timeout', true],
    [409, 'unavailable', true],
    [429, 'rate_limit', true],
    [503, 'unavailable', true],
    [400, 'request_rejected', false],
    [404, 'request_rejected', false],
  ])(
    'classifies HTTP %i without exposing the response body',
    async (status, code, retryable) => {
      fetchMock.mockResolvedValue(
        new Response('test-secret private document', { status }),
      );
      const error = await service()
        .embed(['a'])
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(EmbeddingError);
      expect(error).toMatchObject({ code, retryable });
      expect(String(error)).not.toMatch(/test-secret|private document/u);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes transport errors instead of forwarding their cause', async () => {
    fetchMock.mockRejectedValue(new Error('test-secret private document'));
    await expect(service().embed(['a'])).rejects.toMatchObject({
      message: 'Embedding request failed',
      code: 'unavailable',
      retryable: true,
    });
  });

  it('rejects invalid JSON', async () => {
    fetchMock.mockResolvedValue(new Response('invalid json'));
    await expect(service().embed(['a'])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it.each([
    null,
    {},
    { data: [] },
    { data: [{ index: 0, embedding: [1, 2] }] },
    { data: [{ index: -1, embedding: [1, 2, 3] }] },
    { data: [{ index: 0.5, embedding: [1, 2, 3] }] },
    { data: [{ index: 1, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [0, 0, 0] }] },
    { data: [{ index: 0, embedding: [1, '2', 3] }] },
    { data: [{ index: 0, embedding: [1, null, 3] }] },
    { data: [{ index: 0, embedding: [1, 1e100, 3] }] },
  ])('rejects malformed provider data: %j', async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(service().embed(['a'])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects duplicate indices even when the item count matches', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 0, embedding: [0, 1, 0] },
        ],
      }),
    );
    await expect(service().embed(['a', 'b'])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('does not return a partial result or automatically retry billable requests', async () => {
    fetchMock
      .mockResolvedValueOnce(response([[1, 0, 0]]))
      .mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(
      service({ EMBEDDING_BATCH_SIZE: '1' }).embed(['a', 'b', 'c']),
    ).rejects.toMatchObject({ code: 'rate_limit', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Embedding HTTP deadline', () => {
  let server: Server;
  let url: string;
  let mode: 'slow-headers' | 'slow-body' | 'ok';

  beforeAll(async () => {
    server = createServer((request, reply) => {
      if (request.url !== '/v1/embeddings') {
        reply.writeHead(404);
        reply.end();
        return;
      }
      if (mode === 'slow-headers') return;
      reply.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode === 'slow-body') {
        reply.write('{"data":');
        return;
      }
      reply.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const service = (timeoutMs = 2000) =>
    new EmbeddingsService(
      new ConfigService({
        EMBEDDING_BASE_URL: url,
        EMBEDDING_API_KEY: 'local-test',
        EMBEDDING_MODEL: 'test-model',
        EMBEDDING_DIMENSIONS: '3',
        EMBEDDING_TIMEOUT_MS: String(timeoutMs),
      }),
    );

  it('works against an actual HTTP endpoint', async () => {
    mode = 'ok';
    await expect(service().embed(['a'])).resolves.toMatchObject({
      vectors: [[1, 2, 3]],
    });
  });

  it.each(['slow-headers', 'slow-body'] as const)(
    'aborts %s requests',
    async (value) => {
      mode = value;
      await expect(service(100).embed(['a'])).rejects.toMatchObject({
        code: 'timeout',
        retryable: true,
      });
    },
  );
});
