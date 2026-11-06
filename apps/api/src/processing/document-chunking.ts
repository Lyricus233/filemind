import type { ExtractedDocument } from './document-extractor.service.js';
import { type TextChunk, splitText } from './text-processing.js';

export type ChunkSource =
  | { format: 'pdf'; page: number }
  | { format: 'docx'; paragraphStart: number; paragraphEnd: number };

export interface DocumentChunk extends TextChunk {
  source?: ChunkSource;
}

export function splitDocument(document: ExtractedDocument): DocumentChunk[] {
  if (document.format === 'text') return splitText(document.text);
  if (document.format === 'pdf') {
    const chunks: DocumentChunk[] = [];
    let offset = 0;
    for (const [pageIndex, page] of document.pages.entries()) {
      for (const chunk of splitText(page))
        chunks.push({
          ...chunk,
          index: chunks.length,
          startOffset: chunk.startOffset + offset,
          endOffset: chunk.endOffset + offset,
          source: { format: 'pdf', page: pageIndex + 1 },
        });
      offset += Array.from(page).length + 2;
    }
    return chunks;
  }

  let offset = 0;
  const paragraphs = document.paragraphs
    .map((text, index) => {
      const start = offset;
      offset += Array.from(text).length;
      const end = offset;
      offset += 2;
      return {
        start,
        end,
        number: index + 1,
        searchable: Boolean(text.trim()),
      };
    })
    .filter((paragraph) => paragraph.searchable);
  let first = 0;
  return splitText(document.paragraphs.join('\n\n')).map((chunk) => {
    while (
      first < paragraphs.length &&
      paragraphs[first].end <= chunk.startOffset
    )
      first++;
    let last = first;
    while (
      last + 1 < paragraphs.length &&
      paragraphs[last + 1].start < chunk.endOffset
    )
      last++;
    return {
      ...chunk,
      source: {
        format: 'docx',
        paragraphStart: paragraphs[first].number,
        paragraphEnd: paragraphs[last].number,
      },
    };
  });
}
