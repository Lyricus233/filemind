import 'reflect-metadata';

import { type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { EmbeddingError } from './embedding-error.js';
import { EmbeddingsModule } from './embeddings.module.js';
import { EmbeddingsService } from './embeddings.service.js';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
})
class EmbeddingCheckModule {}

let app: INestApplicationContext | undefined;

try {
  app = await NestFactory.createApplicationContext(EmbeddingCheckModule, {
    logger: false,
    abortOnError: false,
  });
  const args = process.argv.slice(2);
  const text =
    (args[0] === '--' ? args.slice(1) : args).join(' ') ||
    'FileMind embedding connection test';
  const result = await app.get(EmbeddingsService).embed([text]);
  console.log(
    JSON.stringify(
      {
        model: result.model,
        dimensions: result.dimensions,
        count: result.vectors.length,
        vectorPreview: result.vectors[0].slice(0, 8),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof EmbeddingError
      ? `Embedding check failed [${error.code}]: ${error.message}`
      : 'Embedding check failed; verify local configuration',
  );
  process.exitCode = 1;
} finally {
  await app?.close();
}
