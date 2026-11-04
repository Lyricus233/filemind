import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

@Injectable()
export class FileHashBackfillService {
  private readonly logger = new Logger(FileHashBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async run() {
    const result = {
      scanned: 0,
      updated: 0,
      skipped: 0,
      unavailable: 0,
      failed: 0,
    };
    let cursor: string | undefined;
    for (;;) {
      const files = await this.prisma.file.findMany({
        where: {
          contentHash: null,
          deletedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true, storageKey: true },
      });
      if (!files.length) return result;
      for (const file of files) {
        result.scanned++;
        cursor = file.id;
        if (!file.storageKey) {
          result.unavailable++;
          continue;
        }
        let contentHash: string;
        try {
          const stream = await this.storage.openReadStream(file.storageKey);
          const hash = createHash('sha256');
          for await (const chunk of stream) hash.update(chunk);
          contentHash = hash.digest('hex');
        } catch (error) {
          const missing =
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT';
          if (missing) result.unavailable++;
          else result.failed++;
          this.logger.warn(
            `Could not read original content for file ${file.id}`,
          );
          continue;
        }
        const updated = await this.prisma.file.updateMany({
          where: {
            id: file.id,
            storageKey: file.storageKey,
            contentHash: null,
            deletedAt: null,
          },
          data: { contentHash },
        });
        result.updated += updated.count;
        result.skipped += 1 - updated.count;
      }
    }
  }
}
