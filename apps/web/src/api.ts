export type IndexStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface FileRecord {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  createdAt: string;
  indexStatus: IndexStatus;
  processingJob?: Pick<ProcessingJob, 'jobId' | 'state'> | null;
  indexedAt: string | null;
  demoDownloadUrl?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type Source =
  | { format: 'pdf'; page: number }
  | { format: 'docx'; paragraphStart: number; paragraphEnd: number }
  | null;

export interface Passage {
  index: number;
  content: string;
  startOffset: number;
  endOffset: number;
  source: Source;
}

export interface Chunk extends Passage {
  id: string;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit extends Passage {
  chunkId: string;
  file: Pick<FileRecord, 'id' | 'originalName' | 'mimeType'>;
}

export type SearchResponse =
  | ({ mode: 'literal' } & Page<SearchHit & { matches: MatchRange[] }>)
  | {
      mode: 'semantic';
      model: string;
      dimensions: number;
      metric: 'COSINE';
      returned: number;
      limit: number;
      items: (SearchHit & { score: number })[];
    }
  | {
      mode: 'semantic';
      example: true;
      returned: number;
      limit: number;
      items: SearchHit[];
    };

export interface ProcessingJob {
  jobId: string;
  state: string;
  attemptsMade: number;
  phase?: 'reading' | 'extracting' | 'embedding' | 'indexing' | null;
  result: { chunkCount: number; model: string; dimensions: number } | null;
  error: string | null;
}

export const PAGE_SIZE = 20;

export function filePath(id: string) {
  return `/files/${encodeURIComponent(id)}`;
}

export function pageNumber(raw: string | null) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : 1;
}

export function sourceLabel(source: Source) {
  if (source?.format === 'pdf') return `第 ${source.page} 页`;
  if (source?.format === 'docx') {
    const { paragraphStart, paragraphEnd } = source;
    return paragraphStart === paragraphEnd
      ? `第 ${paragraphStart} 段`
      : `第 ${paragraphStart}–${paragraphEnd} 段`;
  }
  return null;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function request(
  path: string,
  init: RequestInit & { method: 'DELETE' },
): Promise<void>;
export function request<T>(path: string, init?: RequestInit): Promise<T>;
export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T | undefined> {
  if (import.meta.env.MODE === 'demo') {
    const { readDemo } = await import('./demo-data');
    init?.signal?.throwIfAborted();
    return readDemo(path, init?.method) as T;
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new Error('无法连接 API。请确认后端服务已启动。');
  }
  const isJson = response.headers
    .get('content-type')
    ?.includes('application/json');
  if (!response.ok) {
    const body = isJson ? await response.json().catch(() => null) : null;
    const message: unknown = body?.message;
    if (typeof message === 'string')
      throw new ApiError(response.status, message);
    if (Array.isArray(message))
      throw new ApiError(response.status, message.join('，'));
    throw new ApiError(
      response.status,
      `请求失败（HTTP ${response.status}）。请检查 API 服务。`,
    );
  }
  if (response.status === 204 && init?.method === 'DELETE') return;
  if (!isJson) throw new Error('API 响应格式异常。请检查前端代理配置。');
  return (await response.json()) as T;
}
