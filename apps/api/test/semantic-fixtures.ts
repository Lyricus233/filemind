import type {
  ChunkVector,
  VectorMatch,
} from '../src/vectors/vector-store.service.js';

export const FIXTURE_MODEL = 'filemind-e2e-model';

export class FixtureVectorStore {
  private readonly rows = new Map<string, ChunkVector>();
  constructor(private readonly collection: string) {}

  async ensureCollection() {
    return { collection: this.collection, model: FIXTURE_MODEL, dimensions: 3 };
  }
  async upsert(chunks: readonly ChunkVector[]) {
    for (const chunk of chunks) this.rows.set(chunk.chunkId, chunk);
    return { count: chunks.length };
  }
  async deleteByFile(fileId: string) {
    for (const [id, row] of this.rows)
      if (row.fileId === fileId) this.rows.delete(id);
  }
  async deleteFromCollection(fileId: string, collection: string) {
    if (collection === this.collection) await this.deleteByFile(fileId);
  }
  async search(
    vector: readonly number[],
    options: {
      limit?: number;
      fileId?: string;
      excludeFileIds?: readonly string[];
    } = {},
  ): Promise<VectorMatch[]> {
    const norm = (value: readonly number[]) => Math.hypot(...value);
    return [...this.rows.values()]
      .filter(
        (row) =>
          (!options.fileId || row.fileId === options.fileId) &&
          !options.excludeFileIds?.includes(row.fileId),
      )
      .map((row) => ({
        chunkId: row.chunkId,
        fileId: row.fileId,
        index: row.index,
        score:
          row.vector.reduce(
            (sum, value, index) => sum + value * vector[index],
            0,
          ) /
          (norm(row.vector) * norm(vector)),
      }))
      .sort((first, second) => second.score - first.score)
      .slice(0, options.limit ?? 20);
  }
}
