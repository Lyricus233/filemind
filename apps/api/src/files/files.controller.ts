import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { create as createContentDisposition } from 'content-disposition';
import { memoryStorage } from 'multer';

import { ProcessingJobsService } from '../processing/processing-jobs.service.js';
import { ListDuplicatesQueryDto } from './dto/list-duplicates-query.dto.js';
import { ListFilesQueryDto } from './dto/list-files-query.dto.js';
import { FileDeletionService } from './file-deletion.service.js';
import { FilesService } from './files.service.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Controller('files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly deletion: FileDeletionService,
    private readonly jobs: ProcessingJobsService,
  ) {}

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.deletion.remove(id);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      defParamCharset: 'utf8',
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 0,
      },
    }),
  )
  upload(
    @UploadedFile(new ParseFilePipe())
    file: Express.Multer.File,
  ) {
    return this.filesService.upload({
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
  }

  @Get()
  async findAll(@Query() query: ListFilesQueryDto) {
    const page = await this.filesService.findAll(query);
    return {
      ...page,
      items: await Promise.all(
        page.items.map((file) => this.jobs.attachStatus(file)),
      ),
    };
  }

  @Get(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const file = await this.filesService.getDownload(id);

    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: createContentDisposition(file.originalName),
      length: Number(file.sizeBytes),
    });
  }

  @Get(':id/duplicates')
  findDuplicates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListDuplicatesQueryDto,
  ) {
    return this.filesService.findDuplicates(id, query);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.attachStatus(await this.filesService.findOne(id));
  }
}
