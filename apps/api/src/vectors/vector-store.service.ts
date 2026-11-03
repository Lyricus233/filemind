import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataType, MetricType, MilvusClient } from '@zilliz/milvus2-sdk-node';

import { VectorStoreError, assertMilvusSuccess } from './vector-store-error.js';
import {
  assertCollectionName,
  milvusClientConfig,
  vectorStoreConfig,
} from './vector-store.config.js';

export interface ChunkVector {
  chunkId: string;
  fileId: string;
  index: number;
  vector: readonly number[];
}

export interface VectorMatch {
  chunkId: string;
  fileId: string;
  index: number;
  score: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WRITE_BATCH_SIZE = 128;

@Injectable()
export class VectorStoreService implements OnModuleDestroy {
  private client?: MilvusClient;
  private settings?: ReturnType<typeof vectorStoreConfig>;
  private ready?: Promise<MilvusClient>;
  private closed = false;

  constructor(private readonly config: ConfigService) {}

  async ensureCollection() {
    await this.connection();
    const { collection, model, dimensions } = this.settings!;
    return { collection, model, dimensions };
  }

  async upsert(chunks: readonly ChunkVector[]) {
    const settings = this.readSettings();
    const ids = new Set<string>();
    // Validate the entire request before writing the first batch.
    for (const chunk of chunks) {
      this.validateId(chunk.chunkId);
      this.validateId(chunk.fileId);
      this.validateVector(chunk.vector);
      if (
        !Number.isInteger(chunk.index) ||
        chunk.index < 0 ||
        chunk.index > 2147483647 ||
        ids.has(chunk.chunkId)
      ) {
        throw new VectorStoreError(
          'Chunk indices must be nonnegative Int32 values and IDs must be unique',
          'invalid_input',
        );
      }
      ids.add(chunk.chunkId);
    }
    if (chunks.length === 0) return { count: 0 };

    return this.operation(async () => {
      const client = await this.connection();
      for (let offset = 0; offset < chunks.length; offset += WRITE_BATCH_SIZE) {
        const batch = chunks.slice(offset, offset + WRITE_BATCH_SIZE);
        const response = await client.upsert({
          collection_name: settings.collection,
          data: batch.map((chunk) => ({
            chunk_id: chunk.chunkId,
            file_id: chunk.fileId,
            chunk_index: chunk.index,
            embedding: [...chunk.vector],
          })),
        });
        assertMilvusSuccess(response.status);
        if (
          response.err_index.length > 0 ||
          Number(response.upsert_cnt) !== batch.length
        ) {
          throw new VectorStoreError(
            'Milvus did not acknowledge every vector in the batch',
            'unavailable',
            true,
          );
        }
      }
      return { count: chunks.length };
    });
  }

  async search(
    vector: readonly number[],
    options: {
      limit?: number;
      fileId?: string;
      excludeFileIds?: readonly string[];
    } = {},
  ): Promise<VectorMatch[]> {
    this.validateVector(vector);
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new VectorStoreError(
        'Vector search limit must be between 1 and 100',
        'invalid_input',
      );
    }
    if (options.fileId !== undefined) this.validateId(options.fileId);
    const excluded = [...new Set(options.excludeFileIds ?? [])];
    excluded.forEach((id) => this.validateId(id));
    const filters: string[] = [];
    if (options.fileId)
      filters.push(`file_id == ${JSON.stringify(options.fileId)}`);
    if (excluded.length)
      filters.push(`file_id not in ${JSON.stringify(excluded)}`);

    return this.operation(async () => {
      const client = await this.connection();
      const response = await client.search({
        collection_name: this.settings!.collection,
        anns_field: 'embedding',
        data: [...vector],
        limit,
        params: { ef: Math.max(64, limit) },
        // SDK 3.x treats numeric Strong (0) as falsy. Use the validated
        // collection's Strong default and explicitly return its custom primary key.
        output_fields: ['chunk_id', 'file_id', 'chunk_index'],
        ...(filters.length ? { filter: filters.join(' and ') } : {}),
      });
      assertMilvusSuccess(response.status);
      const matches: VectorMatch[] = [];
      const seen = new Set<string>();
      for (const row of response.results) {
        if (
          typeof row.chunk_id !== 'string' ||
          !UUID.test(row.chunk_id) ||
          typeof row.file_id !== 'string' ||
          !UUID.test(row.file_id) ||
          !Number.isInteger(row.chunk_index) ||
          row.chunk_index < 0 ||
          row.chunk_index > 2147483647 ||
          !Number.isFinite(row.score) ||
          seen.has(row.chunk_id) ||
          (options.fileId !== undefined && row.file_id !== options.fileId) ||
          excluded.includes(row.file_id as string)
        ) {
          throw new VectorStoreError(
            'Milvus returned an invalid search result',
            'invalid_response',
          );
        }
        seen.add(row.chunk_id);
        matches.push({
          chunkId: row.chunk_id as string,
          fileId: row.file_id as string,
          index: row.chunk_index as number,
          score: row.score,
        });
      }
      if (matches.length > limit)
        throw new VectorStoreError(
          'Milvus exceeded the search limit',
          'invalid_response',
        );
      return matches;
    });
  }

  async deleteByFile(fileId: string) {
    this.validateId(fileId);
    await this.operation(async () => {
      const client = await this.connection();
      const response = await client.delete({
        collection_name: this.settings!.collection,
        filter: `file_id == ${JSON.stringify(fileId)}`,
      });
      assertMilvusSuccess(response.status);
    });
  }

  async onModuleDestroy() {
    this.closed = true;
    await this.ready?.catch(() => undefined);
    await this.client?.closeConnection();
    this.client = undefined;
  }

  async deleteFromCollection(fileId: string, collection: string) {
    this.validateId(fileId);
    assertCollectionName(collection);
    if (this.closed)
      throw new VectorStoreError('Vector store has been closed', 'unavailable');
    await this.operation(async () => {
      const client = new MilvusClient(milvusClientConfig(this.config));
      try {
        await client.connectPromise;
        const exists = await client.hasCollection({
          collection_name: collection,
        });
        assertMilvusSuccess(exists.status);
        if (!exists.value) return;
        await this.load(client, collection);
        const result = await client.delete({
          collection_name: collection,
          filter: `file_id == ${JSON.stringify(fileId)}`,
        });
        assertMilvusSuccess(result.status);
      } finally {
        await client.closeConnection();
      }
    });
  }

  private readSettings() {
    return (this.settings ??= vectorStoreConfig(this.config));
  }

  private connection(): Promise<MilvusClient> {
    if (this.closed)
      return Promise.reject(
        new VectorStoreError('Vector store has been closed', 'unavailable'),
      );
    return (this.ready ??= this.operation(() => this.initialize()).catch(
      (error: unknown) => {
        this.ready = undefined;
        throw error;
      },
    ));
  }

  private async initialize() {
    const settings = this.readSettings();
    const client = new MilvusClient(settings.client);
    this.client = client;
    try {
      await client.connectPromise;
      const request = { collection_name: settings.collection };
      const exists = await client.hasCollection(request);
      assertMilvusSuccess(exists.status);
      if (!exists.value) {
        const created = await client.createCollection({
          ...request,
          description: settings.description,
          consistency_level: 'Strong',
          enable_dynamic_field: false,
          fields: [
            {
              name: 'chunk_id',
              data_type: DataType.VarChar,
              max_length: 36,
              is_primary_key: true,
              autoID: false,
            },
            { name: 'file_id', data_type: DataType.VarChar, max_length: 36 },
            { name: 'chunk_index', data_type: DataType.Int32 },
            {
              name: 'embedding',
              data_type: DataType.FloatVector,
              dim: settings.dimensions,
            },
          ],
        });
        // Another API/worker may have created the collection concurrently.
        if (
          !['Success', 0].includes(created.error_code) ||
          (created.code !== undefined && created.code !== 0)
        ) {
          const raced = await client.hasCollection(request);
          assertMilvusSuccess(raced.status);
          if (!raced.value) assertMilvusSuccess(created);
        }
      }
      const described = await client.describeCollection({
        ...request,
        cache: false,
      });
      assertMilvusSuccess(described.status);
      const fields = described.schema.fields;
      const types = {
        chunk_id: 'VarChar',
        file_id: 'VarChar',
        chunk_index: 'Int32',
        embedding: 'FloatVector',
      };
      const embedding = fields.find((field) => field.name === 'embedding');
      const primary = fields.find((field) => field.name === 'chunk_id');
      if (
        described.schema.description !== settings.description ||
        described.consistency_level !== 'Strong' ||
        fields.length !== 4 ||
        Object.entries(types).some(
          ([name, type]) =>
            !fields.some(
              (field) =>
                field.name === name &&
                field.data_type === type &&
                !field.nullable,
            ),
        ) ||
        !primary?.is_primary_key ||
        primary.autoID ||
        described.schema.autoID ||
        fields.some(
          (field) => field.name !== 'chunk_id' && field.is_primary_key,
        ) ||
        ['chunk_id', 'file_id'].some(
          (name) =>
            !(
              Number(
                fields
                  .find((field) => field.name === name)
                  ?.type_params.find((param) => param.key === 'max_length')
                  ?.value,
              ) >= 36
            ),
        ) ||
        Number(
          embedding?.type_params.find((param) => param.key === 'dim')?.value,
        ) !== settings.dimensions
      ) {
        throw new VectorStoreError(
          'Milvus collection schema, model or consistency differs; choose a new MILVUS_COLLECTION and rebuild its index',
          'schema_mismatch',
        );
      }
      assertMilvusSuccess(
        await client.createIndex({
          ...request,
          field_name: 'embedding',
          index_name: 'embedding_cosine',
          index_type: 'HNSW',
          metric_type: MetricType.COSINE,
          params: { M: 16, efConstruction: 128 },
        }),
      );
      await this.load(client, settings.collection);
      return client;
    } catch (error) {
      await client.closeConnection().catch(() => undefined);
      this.client = undefined;
      throw error;
    }
  }

  private validateId(value: string) {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new VectorStoreError(
        'Vector IDs must be lowercase UUIDs',
        'invalid_input',
      );
    }
  }

  private async load(client: MilvusClient, collection: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const loaded = await Promise.race([
        client.loadCollection({ collection_name: collection }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new VectorStoreError(
                  'Milvus collection loading timed out',
                  'timeout',
                  true,
                ),
              ),
            30000,
          );
        }),
      ]);
      assertMilvusSuccess(loaded);
    } finally {
      clearTimeout(timer);
    }
  }

  private validateVector(vector: readonly number[]) {
    if (
      !Array.isArray(vector) ||
      vector.length !== this.readSettings().dimensions ||
      !Array.from(vector).every(
        (value) =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          Number.isFinite(Math.fround(value)),
      ) ||
      !vector.some((value) => Math.fround(value) !== 0)
    ) {
      throw new VectorStoreError(
        'Vectors must have the configured dimension and finite, nonzero float32 values',
        'invalid_input',
      );
    }
  }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError(
        'Milvus request failed; verify the server and connection configuration',
        'unavailable',
        true,
      );
    }
  }
}
