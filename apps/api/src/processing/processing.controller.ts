import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { BatchProcessingDto } from './dto/batch-processing.dto.js';
import { ListChunksQueryDto } from './dto/list-chunks-query.dto.js';
import { ListProcessingJobsQueryDto } from './dto/list-processing-jobs-query.dto.js';
import { ListRebuildCandidatesQueryDto } from './dto/list-rebuild-candidates-query.dto.js';
import { ProcessingJobsService } from './processing-jobs.service.js';
import { ProcessingService } from './processing.service.js';

@Controller('files')
export class ProcessingController {
  constructor(
    private readonly processingService: ProcessingService,
    private readonly processingJobsService: ProcessingJobsService,
  ) {}

  @Get('index/rebuild-candidates')
  @Header('Cache-Control', 'no-store')
  findRebuildCandidates(@Query() query: ListRebuildCandidatesQueryDto) {
    return this.processingService.findRebuildCandidates(query);
  }

  @Post('process')
  @HttpCode(HttpStatus.OK)
  processBatch(@Body() body: BatchProcessingDto) {
    return this.processingJobsService.enqueueMany(body.fileIds);
  }

  @Post(':id/process')
  @HttpCode(HttpStatus.ACCEPTED)
  process(@Param('id', ParseUUIDPipe) id: string) {
    return this.processingJobsService.enqueue(id);
  }

  @Get(':id/processing-jobs')
  @Header('Cache-Control', 'no-store')
  listJobs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListProcessingJobsQueryDto,
  ) {
    return this.processingJobsService.list(id, query);
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

  @Get(':id/chunks/:chunkId/vector')
  @Header('Cache-Control', 'no-store')
  findChunkVector(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chunkId', ParseUUIDPipe) chunkId: string,
  ) {
    return this.processingService.findChunkVector(id, chunkId);
  }
}
