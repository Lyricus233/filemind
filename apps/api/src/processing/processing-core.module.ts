import { Module } from '@nestjs/common';

import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VectorsModule } from '../vectors/vectors.module.js';
import { DocumentExtractorService } from './document-extractor.service.js';
import { ProcessingHistoryService } from './processing-history.service.js';
import { ProcessingService } from './processing.service.js';

@Module({
  imports: [PrismaModule, StorageModule, EmbeddingsModule, VectorsModule],
  providers: [
    ProcessingService,
    DocumentExtractorService,
    ProcessingHistoryService,
  ],
  exports: [ProcessingService, ProcessingHistoryService],
})
export class ProcessingCoreModule {}
