import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ProcessingCoreModule } from './processing-core.module.js';
import { ProcessingJobsService } from './processing-jobs.service.js';
import { redisConnection } from './processing-queue.config.js';
import { PROCESSING_QUEUE } from './processing-queue.types.js';
import { ProcessingController } from './processing.controller.js';

@Module({
  imports: [
    ProcessingCoreModule,
    PrismaModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnection(config, 'api'),
      }),
    }),
    BullModule.registerQueue({ name: PROCESSING_QUEUE }),
  ],
  controllers: [ProcessingController],
  providers: [ProcessingJobsService],
})
export class ProcessingModule {}
