import { Readable } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parse } from 'content-disposition';
import request from 'supertest';

import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

describe('FilesController download', () => {
  let app: INestApplication;

  const id = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';

  const filesService = {
    getDownload: vi.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        {
          provide: FilesService,
          useValue: filesService,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('downloads the content with its original filename', async () => {
    filesService.getDownload.mockResolvedValue({
      originalName: '学习笔记.txt',
      mimeType: 'text/plain',
      sizeBytes: 5n,
      stream: Readable.from([Buffer.from('hello')]),
    });

    const response = await request(app.getHttpServer())
      .get(`/files/${id}/download`)
      .expect(200)
      .expect('Content-Type', /text\/plain/)
      .expect('Content-Length', '5')
      .expect('hello');

    const disposition = parse(String(response.headers['content-disposition']));

    expect(disposition.type).toBe('attachment');
    expect(disposition.parameters.filename).toBe('学习笔记.txt');
  });

  it('rejects an invalid UUID', async () => {
    await request(app.getHttpServer())
      .get('/files/not-a-uuid/download')
      .expect(400);

    expect(filesService.getDownload).not.toHaveBeenCalled();
  });

  it('returns 404 when file content is unavailable', async () => {
    filesService.getDownload.mockRejectedValue(
      new NotFoundException('File content is unavailable'),
    );

    await request(app.getHttpServer()).get(`/files/${id}/download`).expect(404);
  });
});
