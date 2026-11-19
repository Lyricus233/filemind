import 'reflect-metadata';

import { parseArgs } from 'node:util';

import { type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { isUUID } from 'class-validator';

import { PrismaModule } from '../prisma/prisma.module.js';
import { VectorAuditService } from './vector-audit.service.js';
import { VectorStoreError } from './vector-store-error.js';
import { assertCollectionName } from './vector-store.config.js';
import { MAX_VECTOR_AUDIT_PAGE_SIZE } from './vector-store.service.js';
import { VectorsModule } from './vectors.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    VectorsModule,
  ],
  providers: [VectorAuditService],
})
class VectorAuditModule {}

async function withAuditService<T>(
  run: (service: VectorAuditService) => Promise<T>,
) {
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(VectorAuditModule, {
      logger: ['warn', 'error'],
      abortOnError: false,
    });
    return await run(app.get(VectorAuditService));
  } catch (error) {
    if (error instanceof VectorStoreError) throw error;
    throw new Error(
      'Vector maintenance failed; check the PostgreSQL configuration and connection',
    );
  } finally {
    await app?.close();
  }
}

try {
  const prune = process.argv[2] === 'prune';
  const report = prune
    ? await pruneReference(process.argv.slice(3))
    : await auditReferences(process.argv.slice(2));
  if (report) console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Vector maintenance failed',
  );
  process.exitCode = 1;
}

function requireCollection(collection?: string) {
  if (!collection) throw new Error('--collection <name> is required');
  assertCollectionName(collection);
  return collection;
}

async function pruneReference(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      collection: { type: 'string' },
      'chunk-id': { type: 'string' },
      'file-id': { type: 'string' },
      apply: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'vectors:prune-orphan --collection <name> --chunk-id <UUID> --file-id <UUID> [--apply]',
    );
    return;
  }
  const { 'chunk-id': chunkId, 'file-id': fileId, apply } = values;
  const collection = requireCollection(values.collection);
  if (!chunkId || !isUUID(chunkId, 'all'))
    throw new Error('--chunk-id must be a UUID');
  if (!fileId || !isUUID(fileId, 'all'))
    throw new Error('--file-id must be a UUID');
  const reference = {
    chunkId: chunkId.toLowerCase(),
    fileId: fileId.toLowerCase(),
  };
  return withAuditService((service) =>
    service.prune(collection, reference, apply === true),
  );
}

async function auditReferences(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      collection: { type: 'string' },
      limit: { type: 'string', default: '200' },
      after: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      `vectors:audit --collection <name> [--limit <1–${MAX_VECTOR_AUDIT_PAGE_SIZE}>] [--after <chunk UUID>]`,
    );
    return;
  }
  const collection = requireCollection(values.collection);
  const { after } = values;
  const pageSize = Number(values.limit);
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_VECTOR_AUDIT_PAGE_SIZE
  ) {
    throw new Error(
      `--limit must be an integer between 1 and ${MAX_VECTOR_AUDIT_PAGE_SIZE}`,
    );
  }
  if (after !== undefined && !isUUID(after, 'all'))
    throw new Error('--after must be a chunk UUID');
  return withAuditService((service) =>
    service.audit(collection, pageSize, after?.toLowerCase()),
  );
}
