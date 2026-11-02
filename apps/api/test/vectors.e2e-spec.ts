import { ConfigService } from '@nestjs/config';

import { checkVectorStore } from '../src/vectors/vector-store.smoke.js';

describe('Milvus vector store (e2e)', () => {
  it('writes, ranks, filters, updates and deletes vectors in an isolated collection', async () => {
    const result = await checkVectorStore(
      new ConfigService({
        MILVUS_ADDRESS: process.env.E2E_MILVUS_ADDRESS ?? '127.0.0.1:19530',
        MILVUS_TOKEN: process.env.E2E_MILVUS_TOKEN ?? '',
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      temporaryCollectionRemoved: true,
    });
  }, 90000);
});
