import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { VectorStoreService } from './vector-store.service.js';

@Module({
  imports: [ConfigModule],
  providers: [VectorStoreService],
  exports: [VectorStoreService],
})
export class VectorsModule {}
