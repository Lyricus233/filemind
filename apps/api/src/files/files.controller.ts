import {
  Controller,
  Get,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { ListFilesQueryDto } from './dto/list-files-query.dto.js';
import { FilesService } from './files.service.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

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
  findAll(@Query() query: ListFilesQueryDto) {
    return this.filesService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.findOne(id);
  }
}
