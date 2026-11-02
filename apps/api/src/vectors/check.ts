import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';

import { VectorStoreError } from './vector-store-error.js';
import { checkVectorStore } from './vector-store.smoke.js';

config({ quiet: true });

try {
  console.log(
    JSON.stringify(await checkVectorStore(new ConfigService()), null, 2),
  );
} catch (error) {
  console.error(
    error instanceof VectorStoreError
      ? `Vector check failed [${error.code}]: ${error.message}`
      : 'Vector check failed; verify the Milvus server and local configuration',
  );
  process.exitCode = 1;
}
