import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

import { assertMilvusSuccess } from './vector-store-error.js';
import { vectorStoreConfig } from './vector-store.config.js';
import { VectorStoreService } from './vector-store.service.js';

// Use a temporary collection and synthetic vectors. No model API calls or app data.
export async function checkVectorStore(config: ConfigService) {
  const collection = `filemind_check_${randomUUID().replaceAll('-', '')}`;
  const isolated = new ConfigService({
    MILVUS_ADDRESS: config.get<string>('MILVUS_ADDRESS') ?? '127.0.0.1:19530',
    MILVUS_TOKEN: config.get<string>('MILVUS_TOKEN') ?? '',
    MILVUS_COLLECTION: collection,
    EMBEDDING_MODEL: 'filemind-vector-check',
    EMBEDDING_DIMENSIONS: '3',
  });
  const settings = vectorStoreConfig(isolated);
  const store = new VectorStoreService(isolated);
  const admin = new MilvusClient(settings.client);
  const firstFile = randomUUID();
  const secondFile = randomUUID();
  const firstChunk = randomUUID();
  const secondChunk = randomUUID();
  let owned = false;

  try {
    await admin.connectPromise;
    const existing = await admin.hasCollection({ collection_name: collection });
    assertMilvusSuccess(existing.status);
    assert.equal(
      existing.value,
      false,
      'Refusing to use an existing check collection',
    );
    owned = true;
    await store.ensureCollection();
    const first = {
      chunkId: firstChunk,
      fileId: firstFile,
      index: 0,
      vector: [1, 0, 0],
    };
    assert.deepEqual(
      await store.upsert([
        first,
        {
          chunkId: secondChunk,
          fileId: secondFile,
          index: 1,
          vector: [0, 1, 0],
        },
      ]),
      { count: 2 },
    );

    const matches = await store.search([1, 0, 0], { limit: 2 });
    assert.equal(matches.length, 2);
    assert.equal(matches[0].chunkId, firstChunk);
    assert.ok(matches[0].score > 0.99);
    const filtered = await store.search([1, 0, 0], { fileId: secondFile });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].chunkId, secondChunk);

    await store.upsert([{ ...first, vector: [0, 0, 1] }]);
    const updated = await store.search([0, 0, 1], { fileId: firstFile });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].chunkId, firstChunk);
    assert.ok(updated[0].score > 0.99);
    const oldVector = await store.search([1, 0, 0], { fileId: firstFile });
    assert.ok(Math.abs(oldVector[0].score) < 0.01);

    await store.deleteByFile(firstFile);
    assert.deepEqual(await store.search([0, 0, 1], { fileId: firstFile }), []);
    const retained = await store.search([0, 1, 0], { fileId: secondFile });
    assert.equal(retained.length, 1);
    assert.equal(retained[0].chunkId, secondChunk);
    // An absent file is safe to delete repeatedly.
    await store.deleteByFile(firstFile);
  } finally {
    try {
      await store.onModuleDestroy();
      if (owned && /^filemind_check_[0-9a-f]{32}$/u.test(collection)) {
        const exists = await admin.hasCollection({
          collection_name: collection,
        });
        assertMilvusSuccess(exists.status);
        if (exists.value)
          assertMilvusSuccess(
            await admin.dropCollection({ collection_name: collection }),
          );
      }
    } finally {
      await admin.closeConnection();
    }
  }

  return {
    status: 'ok',
    checks: ['upsert', 'cosine-search', 'file-filter', 'overwrite', 'delete'],
    temporaryCollectionRemoved: true,
  };
}
