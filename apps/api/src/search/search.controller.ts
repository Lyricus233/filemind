import { Controller, Get, Query } from '@nestjs/common';

import { SearchQueryDto } from './dto/search-query.dto.js';
import { SemanticSearchQueryDto } from './dto/semantic-search-query.dto.js';
import { SearchService } from './search.service.js';
import { SemanticSearchService } from './semantic-search.service.js';

@Controller('search')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly semanticSearchService: SemanticSearchService,
  ) {}

  @Get('semantic')
  semantic(@Query() query: SemanticSearchQueryDto) {
    return this.semanticSearchService.search(query);
  }

  @Get()
  search(@Query() query: SearchQueryDto) {
    return this.searchService.search(query);
  }
}
