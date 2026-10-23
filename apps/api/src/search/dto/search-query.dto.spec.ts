import 'reflect-metadata';

import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { SearchQueryDto } from './search-query.dto.js';

describe('SearchQueryDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const transform = (value: unknown) =>
    pipe.transform(value, { type: 'query', metatype: SearchQueryDto });

  it('trims the query and applies pagination defaults', async () => {
    const query: SearchQueryDto = await transform({ q: '  向量  ' });
    expect(query).toBeInstanceOf(SearchQueryDto);
    expect(query).toMatchObject({ q: '向量', page: 1, limit: 20 });
  });

  it('converts pagination strings and accepts an optional file UUID', async () => {
    const fileId = 'e71d88f0-9b85-48bc-8cac-c9b28ac19a2f';
    await expect(
      transform({ q: 'FileMind', page: '2', limit: '10', fileId }),
    ).resolves.toMatchObject({ q: 'FileMind', page: 2, limit: 10, fileId });
  });

  it('accepts literal wildcard characters', async () => {
    await expect(transform({ q: '100%_done' })).resolves.toMatchObject({
      q: '100%_done',
    });
  });

  it('counts a supplementary Unicode character once for the query length limit', async () => {
    await expect(transform({ q: '🙂'.repeat(100) })).resolves.toMatchObject({
      q: '🙂'.repeat(100),
    });
    await expect(transform({ q: '🙂'.repeat(101) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    {},
    { q: '' },
    { q: '   ' },
    { q: ['向量', '搜索'] },
    { q: 'a'.repeat(101) },
    { q: 'a\0b' },
    { q: '向量', page: '0' },
    { q: '向量', page: '1.5' },
    { q: '向量', page: '10001' },
    { q: '向量', limit: '101' },
    { q: '向量', fileId: 'not-a-uuid' },
    { q: '向量', unexpected: 'value' },
  ])('rejects invalid query parameters: %j', async (value) => {
    await expect(transform(value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
