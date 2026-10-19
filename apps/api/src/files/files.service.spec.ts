import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service.js';
import { FilesService } from './files.service.js';

describe('FilesService', () => {
  let service: FilesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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

    service = module.get<FilesService>(FilesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
