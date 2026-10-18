import { Test, TestingModule } from '@nestjs/testing';
import { FilesService } from './files.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
