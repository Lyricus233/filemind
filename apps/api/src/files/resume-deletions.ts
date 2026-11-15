import 'reflect-metadata';

import { parseArgs } from 'node:util';

import { type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { isUUID } from 'class-validator';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VectorsModule } from '../vectors/vectors.module.js';
import { FileCleanupService } from './file-cleanup.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
    VectorsModule,
  ],
  providers: [FileCleanupService],
})
class FileCleanupModule {}

let app: INestApplicationContext | undefined;

try {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean' },
      limit: { type: 'string', default: '20' },
      after: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'files:resume-deletions [--apply] [--limit <1–100>] [--after <file UUID>]',
    );
  } else {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('--limit must be an integer between 1 and 100');
    }
    if (values.after !== undefined && !isUUID(values.after, 'all')) {
      throw new Error('--after must be a file UUID');
    }

    app = await NestFactory.createApplicationContext(FileCleanupModule, {
      logger: ['warn', 'error'],
      abortOnError: false,
    });
    const cleanup = app.get(FileCleanupService);
    const page = await cleanup.listPending(limit, values.after);
    const results = values.apply
      ? await cleanup.resumePending(page.items)
      : undefined;
    console.log(JSON.stringify({ ...page, ...results }, null, 2));
    if (results?.failed.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    app
      ? 'Could not read pending deletions; check the database'
      : error instanceof Error
        ? error.message
        : 'Could not initialize deletion recovery',
  );
  process.exitCode = 1;
} finally {
  await app?.close();
}
