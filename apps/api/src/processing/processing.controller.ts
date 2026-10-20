import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { ListChunksQueryDto } from './dto/list-chunks-query.dto.js';
import { ProcessingService } from './processing.service.js';

@Controller('files')
export class ProcessingController {
  constructor(private readonly processingService: ProcessingService) {}

  @Post(':id/process')
  @HttpCode(HttpStatus.OK)
  process(@Param('id', ParseUUIDPipe) id: string) {
    return this.processingService.process(id);
  }

  @Get(':id/chunks')
  findChunks(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListChunksQueryDto,
  ) {
    return this.processingService.findChunks(id, query);
  }
}
