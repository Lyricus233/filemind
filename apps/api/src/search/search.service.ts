import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SearchQueryDto } from './dto/search-query.dto.js';
import { escapeLikeLiteral, findLiteralMatches } from './literal-search.js';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: SearchQueryDto) {
    const { q, fileId, page, limit } = query;

    const where: Prisma.FileChunkWhereInput = {
      content: { contains: escapeLikeLiteral(q) },
      ...(fileId === undefined ? {} : { fileId }),
    };

    const [chunks, total] = await this.prisma.$transaction(
      [
        this.prisma.fileChunk.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: [{ fileId: 'asc' }, { index: 'asc' }],
          select: {
            id: true,
            index: true,
            content: true,
            startOffset: true,
            endOffset: true,
            file: {
              select: { id: true, originalName: true, mimeType: true },
            },
          },
        }),
        this.prisma.fileChunk.count({ where }),
      ],
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );

    return {
      query: q,
      mode: 'literal' as const,
      caseSensitive: true,
      offsetUnit: 'unicode-code-point' as const,
      items: chunks.map((chunk) => ({
        chunkId: chunk.id,
        file: chunk.file,
        index: chunk.index,
        content: chunk.content,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        matches: findLiteralMatches(chunk.content, q),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
