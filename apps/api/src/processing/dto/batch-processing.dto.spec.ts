import 'reflect-metadata';

import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { BatchProcessingDto } from './batch-processing.dto.js';

describe('BatchProcessingDto', () => {
  const id = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const transform = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: BatchProcessingDto });

  it('accepts 20 UUIDs, including uppercase and repeated IDs', async () => {
    const fileIds = Array.from({ length: 20 }, () => id.toUpperCase());
    await expect(transform({ fileIds })).resolves.toMatchObject({ fileIds });
  });

  it.each([
    {},
    { fileIds: id },
    { fileIds: [] },
    { fileIds: [id, 'invalid'] },
    { fileIds: Array.from({ length: 21 }, () => id) },
    { fileIds: [id], extra: true },
  ])('rejects an invalid request: %j', async (value) => {
    await expect(transform(value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
