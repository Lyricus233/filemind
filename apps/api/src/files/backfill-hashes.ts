import 'reflect-metadata';

import { type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { FileHashBackfillService } from './file-hash-backfill.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
  ],
  providers: [FileHashBackfillService],
})
class FileHashBackfillModule {}

let app: INestApplicationContext | undefined;

try {
  app = await NestFactory.createApplicationContext(FileHashBackfillModule, {
    logger: ['warn', 'error'],
    abortOnError: false,
  });
  const result = await app.get(FileHashBackfillService).run();
  console.log(JSON.stringify(result, null, 2));
  if (result.unavailable || result.failed) process.exitCode = 1;
} catch {
  console.error(
    'File hash backfill failed; verify the database and file storage',
  );
  process.exitCode = 1;
} finally {
  await app?.close();
}
