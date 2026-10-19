import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
