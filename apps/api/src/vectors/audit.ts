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

async function audit(collection: string, limit: number, after?: string) {
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(VectorAuditModule, {
      logger: ['warn', 'error'],
      abortOnError: false,
    });
    return await app.get(VectorAuditService).audit(collection, limit, after);
  } catch (error) {
    if (error instanceof VectorStoreError) throw error;
    throw new Error(
      'Vector audit failed; check the PostgreSQL configuration and connection',
    );
  } finally {
    await app?.close();
  }
}

try {
  const { values } = parseArgs({
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
  } else {
    if (!values.collection) throw new Error('--collection <name> is required');
    assertCollectionName(values.collection);
    const limit = Number(values.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_VECTOR_AUDIT_PAGE_SIZE
    ) {
      throw new Error(
        `--limit must be an integer between 1 and ${MAX_VECTOR_AUDIT_PAGE_SIZE}`,
      );
    }
    if (values.after !== undefined && !isUUID(values.after, 'all')) {
      throw new Error('--after must be a chunk UUID');
    }
    const report = await audit(
      values.collection,
      limit,
      values.after?.toLowerCase(),
    );
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Vector audit failed');
  process.exitCode = 1;
}
