import { PAGE_SIZE, pageNumber } from './api';
import type {
  Chunk,
  FileRecord,
  MatchRange,
  Page,
  SearchHit,
  SearchResponse,
} from './api';
import { DEMO_QUESTION } from './demo';

const documents = [
  {
    id: 'retrieval-notes',
    name: '检索实验笔记.md',
    paragraphs: [
      '向量索引保存每段文本的向量和切片 ID。检索返回候选切片后，系统再读取原文、文件名和字符区间，供读者核对出处。',
      '对同一份资料，关键词检索能定位明确的术语。用一句话描述问题时，则可以比较查询和各段文字的含义，找到表达方式不同的资料。',
      '评估检索时，先标出应当被召回的段落，再比较各方法的前几条结果。记录原文和排序位置，方便重复实验。',
    ],
  },
  {
    id: 'archive-guide',
    name: '研究资料整理指南.txt',
    paragraphs: [
      '不同作者有时会用不同说法讨论同一件事。例如“自动归档”和“按主题整理文件”未必共享关键词，但两段话可能回答同一个问题。',
      '写综述时，先从检索结果跳到原段落，阅读它的前后文，再决定是否引用。建议记录文件名、切片号和字符区间。',
      '为每份资料保留可辨认的标题和原始文件。扫描版资料需要先识别文字，之后才能按内容查找。',
    ],
  },
  {
    id: 'index-checklist',
    name: '索引维护手册.md',
    paragraphs: [
      '排查向量索引写入失败时，先确认文本已成功切片，再检查向量模型和维度是否匹配。修改模型后，应重建与该模型对应的集合。',
      '向量索引中的记录通过切片 ID 关联原文。删除文档时，要同时清理原件、文本切片和向量，避免检索返回已删除的资料。',
      '检索结果的排序只能用于筛选候选，最终仍要对照原文。字面命中可用高亮标出，语义相关的段落则需要结合上下文阅读。',
    ],
  },
];

const files = documents.map(({ id, name, paragraphs }) => {
  const content = paragraphs.join('\n\n');
  const record: FileRecord = {
    id,
    originalName: name,
    mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
    sizeBytes: String(new TextEncoder().encode(content).length),
    createdAt: '2026-11-01T08:00:00.000Z',
    indexStatus: 'READY',
    indexedAt: null,
  };
  let offset = 0;
  const chunks = paragraphs.map((text, index): Chunk => {
    const startOffset = offset;
    const endOffset = startOffset + Array.from(text).length;
    offset = endOffset + 2;
    return {
      id: `${id}-${index + 1}`,
      index,
      content: text,
      startOffset,
      endOffset,
      source: null,
    };
  });
  return { record, content, chunks };
});

const hits = new Map<string, SearchHit>();
for (const { record, chunks } of files) {
  const { id, originalName, mimeType } = record;
  for (const { id: chunkId, ...passage } of chunks) {
    hits.set(chunkId, {
      ...passage,
      chunkId,
      file: { id, originalName, mimeType },
    });
  }
}

function paginate<T>(items: T[], page: number, limit: number): Page<T> {
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total: items.length,
    page,
    limit,
    totalPages: Math.ceil(items.length / limit),
  };
}

function matchesIn(content: string, query: string): MatchRange[] {
  if (!query) return [];
  const length = Array.from(query).length;
  const matches: MatchRange[] = [];
  let offset = content.indexOf(query);
  while (offset !== -1) {
    const start = Array.from(content.slice(0, offset)).length;
    matches.push({ start, end: start + length });
    offset = content.indexOf(query, offset + query.length);
  }
  return matches;
}

function search(
  params: URLSearchParams,
  semantic: boolean,
  page: number,
  limit: number,
): SearchResponse {
  const query = params.get('q')?.trim() ?? '';
  const fileId = params.get('fileId');
  if (semantic) {
    const selected =
      query === DEMO_QUESTION
        ? ['archive-guide-1', 'retrieval-notes-2', 'index-checklist-3']
        : [];
    const items = selected
      .map((id) => hits.get(id))
      .filter(
        (hit): hit is SearchHit =>
          hit !== undefined && (!fileId || hit.file.id === fileId),
      )
      .slice(0, limit);
    return {
      mode: 'semantic',
      example: true,
      returned: items.length,
      limit,
      items,
    };
  }

  const items = [...hits.values()]
    .filter((hit) => !fileId || hit.file.id === fileId)
    .map((hit) => ({ ...hit, matches: matchesIn(hit.content, query) }))
    .filter((hit) => hit.matches.length > 0);
  return { mode: 'literal', ...paginate(items, page, limit) };
}

export function readDemo(path: string, method = 'GET') {
  if (method !== 'GET') throw new Error('公开演示使用只读样本文件。');
  const { pathname, searchParams } = new URL(path, 'https://filemind.invalid');
  const page = pageNumber(searchParams.get('page'));
  const limit = searchParams.has('limit')
    ? Math.min(pageNumber(searchParams.get('limit')), 100)
    : PAGE_SIZE;

  if (pathname === '/search' || pathname === '/search/semantic')
    return search(searchParams, pathname === '/search/semantic', page, limit);

  if (pathname === '/files') {
    const name = searchParams.get('name')?.toLowerCase() ?? '';
    return paginate(
      files
        .map(({ record }) => record)
        .filter((file) => file.originalName.toLowerCase().includes(name)),
      page,
      limit,
    );
  }

  const [, id, view] =
    /^\/files\/([^/]+)(?:\/(chunks))?$/u.exec(pathname) ?? [];
  const file = files.find(({ record }) => record.id === id);
  if (!file) throw new Error('找不到此样本文档。');
  if (view === 'chunks') return paginate(file.chunks, page, limit);
  return {
    ...file.record,
    demoDownloadUrl: `data:${file.record.mimeType};charset=utf-8,${encodeURIComponent(file.content)}`,
  };
}
