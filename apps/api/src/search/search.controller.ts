import { Controller, Get, Query } from '@nestjs/common';

import { SearchQueryDto } from './dto/search-query.dto.js';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(@Query() query: SearchQueryDto) {
    return this.searchService.search(query);
  }
}
