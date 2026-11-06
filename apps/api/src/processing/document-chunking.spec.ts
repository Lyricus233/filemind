import { splitDocument } from './document-chunking.js';

describe('splitDocument', () => {
  it('keeps PDF chunks inside their page and counts blank pages in source locations', () => {
    const pages = ['😀'.repeat(600), '', '第三页正文'];
    const chunks = splitDocument({ format: 'pdf', pages });
    expect(chunks.map((chunk) => chunk.source)).toEqual([
      { format: 'pdf', page: 1 },
      { format: 'pdf', page: 1 },
      { format: 'pdf', page: 3 },
    ]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    const text = Array.from(pages.join('\n\n'));
    for (const chunk of chunks)
      expect(text.slice(chunk.startOffset, chunk.endOffset).join('')).toBe(
        chunk.content,
      );
  });

  it('groups DOCX paragraphs into overlapping chunks and records every covered paragraph', () => {
    const paragraphs = ['甲'.repeat(450), '', '乙😀'.repeat(300), '末段'];
    const chunks = splitDocument({ format: 'docx', paragraphs });
    expect(chunks.map((chunk) => chunk.source)).toEqual([
      { format: 'docx', paragraphStart: 1, paragraphEnd: 3 },
      { format: 'docx', paragraphStart: 1, paragraphEnd: 3 },
      { format: 'docx', paragraphStart: 3, paragraphEnd: 4 },
    ]);
    const text = Array.from(paragraphs.join('\n\n'));
    for (const chunk of chunks)
      expect(text.slice(chunk.startOffset, chunk.endOffset).join('')).toBe(
        chunk.content,
      );
  });

  it('preserves ordinary text chunking without inventing document page locations', () => {
    expect(splitDocument({ format: 'text', text: 'hello😀' })).toEqual([
      { index: 0, content: 'hello😀', startOffset: 0, endOffset: 6 },
    ]);
  });
});
