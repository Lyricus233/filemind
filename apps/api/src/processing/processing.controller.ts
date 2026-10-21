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
import { ProcessingJobsService } from './processing-jobs.service.js';
import { ProcessingService } from './processing.service.js';

@Controller('files')
export class ProcessingController {
  constructor(
    private readonly processingService: ProcessingService,
    private readonly processingJobsService: ProcessingJobsService,
  ) {}

  @Post(':id/process')
  @HttpCode(HttpStatus.ACCEPTED)
  process(@Param('id', ParseUUIDPipe) id: string) {
    return this.processingJobsService.enqueue(id);
  }

  @Get(':id/processing-jobs/:jobId')
  findJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.processingJobsService.findOne(id, jobId);
  }

  @Get(':id/chunks')
  findChunks(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListChunksQueryDto,
  ) {
    return this.processingService.findChunks(id, query);
  }
}
