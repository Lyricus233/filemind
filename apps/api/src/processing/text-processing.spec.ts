import {
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

import { extractText, splitText } from './text-processing.js';

describe('extractText', () => {
  it('removes a UTF-8 BOM and normalizes newlines without trimming content', () => {
    const buffer = Buffer.from('\uFEFFalpha\r\nbeta\rgamma\n ');

    expect(extractText('notes.txt', buffer)).toBe('alpha\nbeta\ngamma\n ');
  });

  it('accepts Markdown extensions without case sensitivity', () => {
    expect(extractText('NOTES.MD', Buffer.from('# Notes'))).toBe('# Notes');
  });

  it('rejects unsupported formats', () => {
    expect(() => extractText('report.pdf', Buffer.from('text'))).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it('rejects invalid UTF-8 instead of replacing malformed bytes', () => {
    expect(() => extractText('notes.txt', Buffer.from([0xc3, 0x28]))).toThrow(
      UnprocessableEntityException,
    );
  });

  it('rejects NUL characters', () => {
    expect(() => extractText('notes.txt', Buffer.from('hello\0world'))).toThrow(
      UnprocessableEntityException,
    );
  });

  it('rejects files containing only whitespace', () => {
    expect(() => extractText('notes.txt', Buffer.from(' \r\n\t'))).toThrow(
      UnprocessableEntityException,
    );
  });
});

describe('splitText', () => {
  it('produces overlapping chunks with exclusive end offsets', () => {
    expect(splitText('abcdefghij', 4, 1)).toEqual([
      { index: 0, content: 'abcd', startOffset: 0, endOffset: 4 },
      { index: 1, content: 'defg', startOffset: 3, endOffset: 7 },
      { index: 2, content: 'ghij', startOffset: 6, endOffset: 10 },
    ]);
  });

  it('does not append a redundant overlap-only suffix', () => {
    expect(splitText('abcd', 4, 1)).toHaveLength(1);
  });

  it('preserves Unicode code points and uses code-point offsets', () => {
    expect(splitText('甲😀乙🙂丙', 2, 0)).toEqual([
      { index: 0, content: '甲😀', startOffset: 0, endOffset: 2 },
      { index: 1, content: '乙🙂', startOffset: 2, endOffset: 4 },
      { index: 2, content: '丙', startOffset: 4, endOffset: 5 },
    ]);
  });

  it('keeps sequential indexes after skipping whitespace-only chunks', () => {
    expect(splitText('    abcd', 4, 0)).toEqual([
      { index: 0, content: 'abcd', startOffset: 4, endOffset: 8 },
    ]);
  });

  it('returns no chunks for an empty string', () => {
    expect(splitText('')).toEqual([]);
  });

  it.each([
    [0, 0],
    [4, 4],
    [4, -1],
    [4, 1.5],
    [Infinity, 0],
  ])('rejects invalid chunkSize=%s overlap=%s', (chunkSize, overlap) => {
    expect(() => splitText('hello', chunkSize, overlap)).toThrow(RangeError);
  });
});
