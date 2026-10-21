import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ProcessingService } from './processing.service.js';

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [ProcessingService],
  exports: [ProcessingService],
})
export class ProcessingCoreModule {}
