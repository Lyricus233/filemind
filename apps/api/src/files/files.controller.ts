import {
  Controller,
  Get,
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

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.findOne(id);
  }
}
