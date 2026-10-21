import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  new Logger('WorkerBootstrap').error(error);
  process.exitCode = 1;
});
