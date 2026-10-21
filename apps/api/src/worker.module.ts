import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { ProcessingCoreModule } from './processing/processing-core.module.js';
import { redisConnection } from './processing/processing-queue.config.js';
import { PROCESSING_QUEUE } from './processing/processing-queue.types.js';
import { ProcessingProcessor } from './processing/processing.processor.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ProcessingCoreModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnection(config, 'worker'),
      }),
    }),
    BullModule.registerQueue({ name: PROCESSING_QUEUE }),
  ],
  providers: [ProcessingProcessor],
})
export class WorkerModule {}
