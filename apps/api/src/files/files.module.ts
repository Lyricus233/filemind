import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ProcessingModule } from '../processing/processing.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VectorsModule } from '../vectors/vectors.module.js';
import { FileDeletionService } from './file-deletion.service.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

@Module({
  imports: [PrismaModule, StorageModule, ProcessingModule, VectorsModule],
  controllers: [FilesController],
  providers: [FilesService, FileDeletionService],
})
export class FilesModule {}
