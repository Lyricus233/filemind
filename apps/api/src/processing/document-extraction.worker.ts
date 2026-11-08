import 'reflect-metadata';

import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';

import { HttpException, UnprocessableEntityException } from '@nestjs/common';

import { splitDocument } from './document-chunking.js';
import { DocumentExtractorService } from './document-extractor.service.js';

type Input = { originalName: string; buffer: Uint8Array };
type Response = { type: 'document-extraction-result' } & (
  | { chunks: ReturnType<typeof splitDocument> }
  | { message: string; status?: number }
);

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { originalName, buffer } = workerData as Input;
  void new DocumentExtractorService()
    .extract(originalName, Buffer.from(buffer))
    .then(splitDocument)
    .then((chunks) =>
      port.postMessage({
        type: 'document-extraction-result',
        chunks,
      } satisfies Response),
    )
    .catch((error: unknown) => {
      port.postMessage({
        type: 'document-extraction-result',
        message:
          error instanceof Error ? error.message : 'Document extraction failed',
        status: error instanceof HttpException ? error.getStatus() : undefined,
      } satisfies Response);
    });
}

export function extractChunksInWorker(originalName: string, buffer: Buffer) {
  return new Promise<ReturnType<typeof splitDocument>>((resolve, reject) => {
    const entry = import.meta.url.endsWith('.ts')
      ? new URL(
          '../../dist/processing/document-extraction.worker.js',
          import.meta.url,
        )
      : new URL(import.meta.url);
    const worker = new Worker(entry, {
      workerData: { originalName, buffer } satisfies Input,
      execArgv: [],
    });
    const deadline = setTimeout(() => {
      reject(
        new UnprocessableEntityException(
          'Document extraction exceeded two minutes',
        ),
      );
      void worker.terminate().catch(() => undefined);
    }, 120_000);
    worker.on('message', (response: Response) => {
      if (response?.type !== 'document-extraction-result') return;
      clearTimeout(deadline);
      if ('chunks' in response) resolve(response.chunks);
      else
        reject(
          response.status
            ? new HttpException(response.message, response.status)
            : new Error(response.message),
        );
    });
    worker.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(deadline);
      reject(
        new Error(
          `Document extraction worker exited without a result (${code})`,
        ),
      );
    });
  });
}
