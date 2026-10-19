import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

describe('FilesController', () => {
  let controller: FilesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        FilesService,
        {
          provide: PrismaService,
          useValue: {
            file: {
              findMany: vi.fn().mockResolvedValue([]),
            },
          },
        },
      ],
    }).compile();

    controller = module.get<FilesController>(FilesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
