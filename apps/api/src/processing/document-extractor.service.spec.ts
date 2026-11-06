import { readFile } from 'node:fs/promises';

import {
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

import { splitDocument } from './document-chunking.js';
import {
  DocumentExtractorService,
  MAX_DOCUMENT_CHARACTERS,
} from './document-extractor.service.js';

const fixture = (name: string) =>
  readFile(new URL(`../../test/fixtures/${name}`, import.meta.url));

describe('DocumentExtractorService', () => {
  const service = new DocumentExtractorService();

  it('preserves strict UTF-8 extraction for text and Markdown', async () => {
    await expect(
      service.extract('NOTES.MD', Buffer.from('\uFEFF# Title\r\n原文😀')),
    ).resolves.toEqual({
      format: 'text',
      text: '# Title\n原文😀',
    });
    await expect(
      service.extract('bad.txt', Buffer.from([0xff])),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('extracts real Chinese and English PDF text with page boundaries and releases resources for reuse', async () => {
    const bytes = await fixture('two-pages.pdf');
    for (let attempt = 0; attempt < 2; attempt++) {
      const document = await service.extract('REPORT.PDF', bytes);
      expect(document.format).toBe('pdf');
      if (document.format !== 'pdf') throw new Error('Expected PDF result');
      expect(document.pages).toHaveLength(2);
      expect(document.pages[0]).toContain('出门请带雨伞');
      expect(document.pages[0]).toContain('First page');
      expect(document.pages[1]).toContain('数据库索引');
      const text = Array.from(document.pages.join('\n\n'));
      const chunks = splitDocument(document);
      expect(chunks.map((chunk) => chunk.source)).toEqual([
        { format: 'pdf', page: 1 },
        { format: 'pdf', page: 2 },
      ]);
      for (const chunk of chunks)
        expect(text.slice(chunk.startOffset, chunk.endOffset).join('')).toBe(
          chunk.content,
        );
    }
  }, 15000);

  it('extracts a real DOCX with paragraph boundaries and decoded Unicode/XML characters', async () => {
    const document = await service.extract(
      'notes.docx',
      await fixture('paragraphs.docx'),
    );
    expect(document.format).toBe('docx');
    if (document.format !== 'docx') throw new Error('Expected DOCX result');
    expect(document.paragraphs.slice(0, 3)).toEqual([
      '第一段：天气预报有雨，出门请带雨伞。',
      '第二段：数据库索引加快查询与文件检索。',
      'Unicode content: 😀 & <original> text.',
    ]);
    expect(splitDocument(document)[0].source).toEqual({
      format: 'docx',
      paragraphStart: 1,
      paragraphEnd: 3,
    });
  });

  it.each(['empty.pdf', 'empty.docx'])(
    'rejects a real document with no extractable text: %s',
    async (name) => {
      await expect(
        service.extract(name, await fixture(name)),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    },
  );

  it.each(['broken.pdf', 'broken.docx'])(
    'maps malformed document input to a stable error without leaking parser details: %s',
    async (name) => {
      await expect(
        service.extract(name, Buffer.from('not a document')),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    },
  );

  it('bounds extracted text before any embedding or indexing work', async () => {
    await expect(
      service.extract(
        'large.txt',
        Buffer.from('字'.repeat(MAX_DOCUMENT_CHARACTERS + 1)),
      ),
    ).rejects.toThrow('exceeds');
  });

  it('rejects unsupported document types', async () => {
    await expect(
      service.extract('legacy.doc', Buffer.from('text')),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });
});
