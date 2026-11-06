import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Injectable, UnprocessableEntityException } from '@nestjs/common';

import { extractText } from './text-processing.js';

export type ExtractedDocument =
  | { format: 'text'; text: string }
  | { format: 'pdf'; pages: string[] }
  | { format: 'docx'; paragraphs: string[] };

export const MAX_DOCUMENT_CHARACTERS = 1_000_000;
export const MAX_PDF_PAGES = 500;

@Injectable()
export class DocumentExtractorService {
  async extract(
    originalName: string,
    buffer: Buffer,
  ): Promise<ExtractedDocument> {
    switch (extname(originalName).toLowerCase()) {
      case '.pdf':
        return this.pdf(buffer);
      case '.docx':
        return this.docx(buffer);
      default: {
        const text = extractText(originalName, buffer);
        this.validate(text);
        return { format: 'text', text };
      }
    }
  }

  private async pdf(buffer: Buffer): Promise<ExtractedDocument> {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const entry = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const assets = (directory: string) =>
      fileURLToPath(new URL(`../../${directory}/`, entry)).replaceAll(
        '\\',
        '/',
      );
    const loading = getDocument({
      data: Uint8Array.from(buffer),
      cMapUrl: assets('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assets('standard_fonts'),
      wasmUrl: assets('wasm'),
      useWorkerFetch: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    try {
      const document = await loading.promise;
      if (document.numPages > MAX_PDF_PAGES)
        throw new UnprocessableEntityException(
          `PDF exceeds ${MAX_PDF_PAGES} pages`,
        );
      const pages: string[] = [];
      let characters = 0;
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        try {
          const { items } = await page.getTextContent();
          const text = items
            .flatMap((item) =>
              'str' in item ? [item.str, item.hasEOL ? '\n' : ''] : [],
            )
            .join('')
            .replace(/\r\n?/gu, '\n');
          characters += Array.from(text).length + (index > 1 ? 2 : 0);
          this.validateLength(characters);
          pages.push(text);
        } finally {
          page.cleanup();
        }
      }
      if (pages.every((text) => !text.trim()))
        throw new UnprocessableEntityException(
          'PDF has no extractable text; image-only documents require OCR',
        );
      this.validate(pages.join('\n\n'));
      return { format: 'pdf', pages };
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      const locked =
        error instanceof Error && error.name === 'PasswordException';
      throw new UnprocessableEntityException(
        locked
          ? 'Password-protected PDFs are not supported'
          : 'PDF could not be parsed',
      );
    } finally {
      await loading.destroy();
    }
  }

  private async docx(buffer: Buffer): Promise<ExtractedDocument> {
    const { default: mammoth } = await import('mammoth');
    let text: string;
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.messages.some((message) => message.type === 'error'))
        throw new Error('DOCX extraction reported errors');
      text = result.value.replace(/\r\n?/gu, '\n');
    } catch {
      throw new UnprocessableEntityException(
        'DOCX could not be parsed; check that it is a valid, unencrypted document',
      );
    }
    this.validate(text);
    return { format: 'docx', paragraphs: text.split('\n\n') };
  }

  private validate(text: string) {
    this.validateLength(Array.from(text).length);
    if (text.includes('\0'))
      throw new UnprocessableEntityException('File contains NUL characters');
    if (!text.trim())
      throw new UnprocessableEntityException('File has no searchable text');
  }

  private validateLength(characters: number) {
    if (characters > MAX_DOCUMENT_CHARACTERS)
      throw new UnprocessableEntityException(
        `Extracted text exceeds ${MAX_DOCUMENT_CHARACTERS} Unicode characters`,
      );
  }
}
