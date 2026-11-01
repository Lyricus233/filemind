import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import { EmbeddingError } from './embedding-error.js';

interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
}

export interface EmbeddingResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class EmbeddingsService {
  constructor(private readonly config: ConfigService) {}

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    if (
      texts.length === 0 ||
      texts.some((text) => typeof text !== 'string' || text.trim().length === 0)
    ) {
      throw new EmbeddingError(
        'Embedding inputs must be non-empty strings',
        'invalid_input',
      );
    }

    const config = this.readConfig();
    const client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: 0,
      logLevel: 'off',
      fetchOptions: { redirect: 'error' },
    });
    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += config.batchSize) {
      const batch = texts.slice(offset, offset + config.batchSize);
      vectors.push(...(await this.requestBatch(client, batch, config)));
    }

    return { model: config.model, dimensions: config.dimensions, vectors };
  }

  private readConfig(): EmbeddingConfig {
    const required = (name: string) => {
      const value = this.config.get<string>(name)?.trim();
      if (!value) {
        throw new EmbeddingError(
          `Set ${name} before using embeddings`,
          'configuration',
        );
      }
      return value;
    };
    const integer = (name: string, maximum: number, fallback?: number) => {
      const raw = this.config.get<string>(name);
      const value = raw === undefined ? fallback : Number(raw);
      if (
        value === undefined ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > maximum
      ) {
        throw new EmbeddingError(
          `${name} must be an integer between 1 and ${maximum}`,
          'configuration',
        );
      }
      return value;
    };

    const rawUrl = required('EMBEDDING_BASE_URL');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new EmbeddingError(
        'EMBEDDING_BASE_URL must be a valid URL',
        'configuration',
      );
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    ) {
      throw new EmbeddingError(
        'EMBEDDING_BASE_URL must use HTTPS (HTTP is allowed for loopback) without credentials, query or fragment',
        'configuration',
      );
    }
    if (/\/embeddings\/?$/iu.test(url.pathname)) {
      throw new EmbeddingError(
        'EMBEDDING_BASE_URL must omit /embeddings; the SDK appends it',
        'configuration',
      );
    }

    const apiKey = required('EMBEDDING_API_KEY');
    if (/[\r\n]/u.test(apiKey)) {
      throw new EmbeddingError(
        'EMBEDDING_API_KEY contains invalid characters',
        'configuration',
      );
    }

    return {
      baseURL: url.toString().replace(/\/+$/u, ''),
      apiKey,
      model: required('EMBEDDING_MODEL'),
      dimensions: integer('EMBEDDING_DIMENSIONS', 32768),
      batchSize: integer('EMBEDDING_BATCH_SIZE', 128, 16),
      timeoutMs: integer('EMBEDDING_TIMEOUT_MS', 120000, 30000),
    };
  }

  private async requestBatch(
    client: OpenAI,
    texts: readonly string[],
    config: EmbeddingConfig,
  ) {
    // Bound the entire batch, including response-body reading. The caller owns retries.
    const signal = AbortSignal.timeout(config.timeoutMs);
    let body: unknown;

    try {
      body = await client.embeddings.create(
        {
          model: config.model,
          input: [...texts],
          encoding_format: 'float',
        },
        { signal },
      );
    } catch (error) {
      throw this.requestError(error, signal);
    }

    // SDK response types are not runtime validation for third-party providers.
    if (
      !isRecord(body) ||
      !Array.isArray(body.data) ||
      body.data.length !== texts.length
    ) {
      throw new EmbeddingError(
        'Embedding response has an unexpected item count',
        'invalid_response',
      );
    }

    const vectors: number[][] = [];
    const seen = new Set<number>();

    for (const item of body.data as unknown[]) {
      if (
        !isRecord(item) ||
        typeof item.index !== 'number' ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= texts.length ||
        seen.has(item.index) ||
        !Array.isArray(item.embedding) ||
        item.embedding.length !== config.dimensions ||
        !item.embedding.every(
          (value: unknown) =>
            typeof value === 'number' &&
            Number.isFinite(value) &&
            Number.isFinite(Math.fround(value)),
        ) ||
        !item.embedding.some((value: number) => Math.fround(value) !== 0)
      ) {
        throw new EmbeddingError(
          'Embedding response contains an invalid vector or index',
          'invalid_response',
        );
      }
      seen.add(item.index);
      vectors[item.index] = item.embedding as number[];
    }

    return vectors;
  }

  private requestError(error: unknown, signal: AbortSignal): EmbeddingError {
    // Keep provider bodies, headers, and nested transport causes out of public errors.
    if (signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
      return new EmbeddingError('Embedding request timed out', 'timeout', true);
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new EmbeddingError(
        'Embedding request failed',
        'unavailable',
        true,
      );
    }
    if (error instanceof OpenAI.APIError && error.status !== undefined) {
      const status = error.status;
      if (status === 401 || status === 403) {
        return new EmbeddingError(
          'Embedding authentication failed',
          'authentication',
        );
      }
      if (status === 429) {
        return new EmbeddingError(
          'Embedding rate limit reached',
          'rate_limit',
          true,
        );
      }
      if (status === 408) {
        return new EmbeddingError(
          'Embedding request timed out',
          'timeout',
          true,
        );
      }
      const retryable = status === 409 || status >= 500;
      return new EmbeddingError(
        `Embedding provider returned HTTP ${status}`,
        retryable ? 'unavailable' : 'request_rejected',
        retryable,
      );
    }
    if (error instanceof SyntaxError) {
      return new EmbeddingError(
        'Embedding provider returned invalid JSON',
        'invalid_response',
      );
    }
    return new EmbeddingError('Embedding request failed', 'unavailable', true);
  }
}
