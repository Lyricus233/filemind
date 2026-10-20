import { extname } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

export const CHUNK_SIZE = 500;
export const CHUNK_OVERLAP = 100;

export interface TextChunk {
  index: number;
  content: string;
  startOffset: number;
  endOffset: number;
}

export function extractText(originalName: string, buffer: Buffer): string {
  const extension = extname(originalName).toLowerCase();

  if (extension !== '.txt' && extension !== '.md') {
    throw new UnsupportedMediaTypeException(
      'Only UTF-8 .txt and .md files are supported',
    );
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new UnprocessableEntityException('File is not valid UTF-8');
  }

  text = text.replace(/\r\n?/g, '\n');

  if (text.includes('\0')) {
    throw new UnprocessableEntityException('File contains NUL characters');
  }

  if (text.trim().length === 0) {
    throw new UnprocessableEntityException('File has no searchable text');
  }

  return text;
}

export function splitText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): TextChunk[] {
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap >= chunkSize
  ) {
    throw new RangeError('Require chunkSize > 0 and 0 <= overlap < chunkSize');
  }

  const characters = Array.from(text);
  const chunks: TextChunk[] = [];

  for (let start = 0; start < characters.length; start += chunkSize - overlap) {
    const end = Math.min(start + chunkSize, characters.length);
    const content = characters.slice(start, end).join('');

    if (content.trim().length > 0) {
      chunks.push({
        index: chunks.length,
        content,
        startOffset: start,
        endOffset: end,
      });
    }

    if (end === characters.length) {
      break;
    }
  }

  return chunks;
}
