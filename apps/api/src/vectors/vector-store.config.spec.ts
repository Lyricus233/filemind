import { ConfigService } from '@nestjs/config';

import { vectorStoreConfig } from './vector-store.config.js';

describe('vectorStoreConfig', () => {
  const settings = {
    EMBEDDING_MODEL: 'test-model',
    EMBEDDING_DIMENSIONS: '1024',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    vectorStoreConfig(new ConfigService({ ...settings, ...overrides }));

  it('has local defaults and reuses the embedding model and dimensions', () => {
    expect(read()).toMatchObject({
      client: { address: '127.0.0.1:19530', ssl: false },
      collection: 'filemind_chunks_v1',
      model: 'test-model',
      dimensions: 1024,
    });
  });

  it('enables TLS and accepts a separately configured token', () => {
    expect(
      read({
        MILVUS_ADDRESS: 'https://milvus.example:443',
        MILVUS_TOKEN: 'test-token',
      }).client,
    ).toMatchObject({
      address: 'milvus.example:443',
      ssl: true,
      token: 'test-token',
    });
  });

  it.each([
    ['milvus.example', 'milvus.example:19530'],
    ['milvus.example:80', 'milvus.example:80'],
    ['https://milvus.example', 'milvus.example:443'],
    ['http://milvus.example:80', 'milvus.example:80'],
    ['[::1]:19530', '[::1]:19530'],
  ])('preserves connection ports for %s', (address, expected) => {
    expect(read({ MILVUS_ADDRESS: address }).client.address).toBe(expected);
  });

  it.each(['127.0.0.1:19530', 'localhost:19530', '[::1]:19530'])(
    'connects to loopback %s without an inherited HTTP proxy',
    (address) => {
      expect(read({ MILVUS_ADDRESS: address }).client.channelOptions).toEqual({
        'grpc.enable_http_proxy': 0,
      });
      expect(
        read({ MILVUS_ADDRESS: 'https://milvus.example:443' }).client
          .channelOptions,
      ).toBeUndefined();
    },
  );

  it.each([
    { MILVUS_ADDRESS: '' },
    { MILVUS_ADDRESS: 'ftp://milvus.example:19530' },
    { MILVUS_ADDRESS: 'https://milvus.example/path' },
    { MILVUS_ADDRESS: 'https://user:password@milvus.example' },
    { MILVUS_ADDRESS: 'https://milvus.example?token=secret' },
    { MILVUS_ADDRESS: 'https://milvus.example#fragment' },
    { MILVUS_TOKEN: 'secret\nvalue' },
    { MILVUS_COLLECTION: '' },
    { MILVUS_COLLECTION: 'invalid-name' },
    { MILVUS_COLLECTION: 'a'.repeat(256) },
    { EMBEDDING_MODEL: '' },
    { EMBEDDING_DIMENSIONS: '1' },
    { EMBEDDING_DIMENSIONS: '1024.5' },
    { EMBEDDING_DIMENSIONS: '32769' },
    { EMBEDDING_DIMENSIONS: 'NaN' },
  ])('rejects invalid connection and collection settings: %j', (overrides) => {
    expect(() => read(overrides)).toThrow();
  });
});
