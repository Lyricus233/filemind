import { ConfigService } from '@nestjs/config';
import type { ClientConfig } from '@zilliz/milvus2-sdk-node';

import { VectorStoreError } from './vector-store-error.js';

export function milvusClientConfig(config: ConfigService): ClientConfig {
  const address =
    config.get<string>('MILVUS_ADDRESS')?.trim() ?? '127.0.0.1:19530';
  const token = config.get<string>('MILVUS_TOKEN')?.trim();

  let url: URL;
  try {
    url = new URL(address.includes('://') ? address : `http://${address}`);
  } catch {
    throw new VectorStoreError(
      'MILVUS_ADDRESS must be a host and port or HTTP(S) URL',
      'configuration',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    /[\r\n]/u.test(token ?? '')
  ) {
    throw new VectorStoreError(
      'Invalid Milvus connection configuration',
      'configuration',
    );
  }
  const explicitPort = /:(\d+)\/?$/u.exec(address)?.[1];
  const port =
    url.port ||
    explicitPort ||
    (address.includes('://')
      ? url.protocol === 'https:'
        ? '443'
        : '80'
      : '19530');
  const client: ClientConfig = {
    address: `${url.hostname}:${port}`,
    ssl: url.protocol === 'https:',
    // Local gRPC traffic must not inherit the desktop's HTTP proxy.
    ...(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? { channelOptions: { 'grpc.enable_http_proxy': 0 } }
      : {}),
    ...(token ? { token } : {}),
    timeout: 10000,
    maxRetries: 0,
    logLevel: 'error',
    telemetry: { enabled: false },
  };
  return client;
}

export function assertCollectionName(collection: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/u.test(collection)) {
    throw new VectorStoreError(
      'Milvus collection name is invalid',
      'configuration',
    );
  }
}

export function vectorStoreConfig(config: ConfigService) {
  const collection =
    config.get<string>('MILVUS_COLLECTION')?.trim() ?? 'filemind_chunks_v1';
  const model = config.get<string>('EMBEDDING_MODEL')?.trim();
  const dimensions = Number(config.get<string>('EMBEDDING_DIMENSIONS'));
  assertCollectionName(collection);
  if (
    !model ||
    !Number.isInteger(dimensions) ||
    dimensions < 2 ||
    dimensions > 32768
  ) {
    throw new VectorStoreError(
      'Set EMBEDDING_MODEL and EMBEDDING_DIMENSIONS (2–32768) before using vectors',
      'configuration',
    );
  }
  return {
    client: milvusClientConfig(config),
    collection,
    model,
    dimensions,
    description: JSON.stringify({
      application: 'filemind',
      schemaVersion: 1,
      model,
      dimensions,
    }),
  };
}
