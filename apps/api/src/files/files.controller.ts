import { Body, Controller, Get, Post } from '@nestjs/common';

import { CreateFileDto } from './dto/create-file.dto.js';
import { FilesService } from './files.service.js';

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post()
  create(@Body() createFileDto: CreateFileDto) {
    return this.filesService.create(createFileDto);
  }

  @Get()
  findAll() {
    return this.filesService.findAll();
  }
}
