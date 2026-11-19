import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { VectorStoreService } from './vector-store.service.js';
import type { ChunkReference } from './vector-store.service.js';

@Injectable()
export class VectorAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectors: VectorStoreService,
  ) {}

  async prune(collection: string, reference: ChunkReference, apply: boolean) {
    const { chunkId, fileId } = reference;
    const target = { collection, chunkId, fileId };
    const stored = await this.vectors.findChunkReference(collection, chunkId);
    if (!stored) return { ...target, status: 'missing_vector' };
    if (stored.fileId !== fileId)
      return { ...target, status: 'reference_changed' };

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true },
    });
    if (file) return { ...target, status: 'protected_file' };

    const chunk = await this.prisma.fileChunk.findUnique({
      where: { id: chunkId },
      select: { id: true },
    });
    if (chunk) return { ...target, status: 'protected_chunk' };
    if (!apply) return { ...target, status: 'orphaned' };

    const deleted = await this.vectors.deleteChunkReference(
      collection,
      reference,
    );
    return { ...target, status: deleted ? 'deleted' : 'no_match' };
  }

  async audit(collection: string, limit: number, after?: string) {
    const page = await this.vectors.listChunkReferences(
      collection,
      limit,
      after,
    );
    const fileIds = [...new Set(page.items.map(({ fileId }) => fileId))];
    const files = fileIds.length
      ? await this.prisma.file.findMany({
          where: { id: { in: fileIds } },
          select: {
            id: true,
            vectorCollection: true,
            vectorIndexes: {
              where: { collection },
              select: { collection: true },
            },
          },
        })
      : [];
    const byId = new Map(files.map((file) => [file.id, file]));
    const findings = page.items.flatMap((item) => {
      const file = byId.get(item.fileId);
      if (
        file &&
        (file.vectorCollection === collection || file.vectorIndexes.length)
      )
        return [];
      const reason = file ? 'untracked_collection' : 'missing_file';
      return [{ ...item, reason }];
    });

    return {
      collection,
      scanned: page.items.length,
      findings,
      nextCursor: page.nextCursor,
    };
  }
}
