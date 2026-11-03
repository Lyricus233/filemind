import 'reflect-metadata';

import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { SemanticSearchQueryDto } from './semantic-search-query.dto.js';

describe('SemanticSearchQueryDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const transform = (value: unknown) =>
    pipe.transform(value, { type: 'query', metatype: SemanticSearchQueryDto });

  it('trims text, applies a limit and normalizes the file UUID', async () => {
    await expect(
      transform({
        q: '  rainy weather  ',
        fileId: 'ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456',
      }),
    ).resolves.toMatchObject({
      q: 'rainy weather',
      limit: 20,
      fileId: 'abcdef12-abcd-4abc-8abc-abcdef123456',
    });
  });

  it.each([
    {},
    { q: ' ' },
    { q: ['a', 'b'] },
    { q: '🙂'.repeat(1001) },
    { q: 'a\0b' },
    { q: 'x', limit: 0 },
    { q: 'x', limit: 101 },
    { q: 'x', limit: 1.5 },
    { q: 'x', fileId: 'invalid' },
    { q: 'x', page: 1 },
  ])('rejects an invalid semantic request: %j', async (value) => {
    await expect(transform(value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
