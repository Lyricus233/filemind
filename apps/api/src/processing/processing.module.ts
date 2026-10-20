import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ProcessingController } from './processing.controller.js';
import { ProcessingService } from './processing.service.js';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [ProcessingController],
  providers: [ProcessingService],
})
export class ProcessingModule {}
