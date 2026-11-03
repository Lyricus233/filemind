import { Module } from '@nestjs/common';

import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { VectorsModule } from '../vectors/vectors.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { SemanticSearchService } from './semantic-search.service.js';

@Module({
  imports: [PrismaModule, EmbeddingsModule, VectorsModule],
  controllers: [SearchController],
  providers: [SearchService, SemanticSearchService],
})
export class SearchModule {}
