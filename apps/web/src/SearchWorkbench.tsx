import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Eye,
  Files,
  Info,
  MapPin,
  Search,
  TextQuote,
} from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { PAGE_SIZE, filePath, pageNumber, sourceLabel } from './api';
import type { FileRecord, Page, SearchResponse } from './api';
import { DEMO_KEYWORD, DEMO_MODE, DEMO_QUESTION } from './demo';
import { DocumentIcon, PassageText, fileType, jumpToPageAnchor } from './ui';
import { useResource } from './use-resource';

type Mode = SearchResponse['mode'];
type Hit = SearchResponse['items'][number];

function ScopePicker({
  fileId,
  onChange,
}: {
  fileId: string;
  onChange: (id: string) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter.trim());
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const selected = useResource<FileRecord>(fileId ? filePath(fileId) : null);
  const query = new URLSearchParams({ page: String(page), limit: '8' });
  if (deferredFilter) query.set('name', deferredFilter);
  const files = useResource<Page<FileRecord>>(
    open ? `/files?${query}` : null,
    refresh,
  );

  function choose(id: string) {
    onChange(id);
    if (details.current) details.current.open = false;
  }

  return (
    <details
      className="wp-scope"
      ref={details}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && details.current) {
          details.current.open = false;
          details.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary>
        <span className="wp-scope-label">范围</span>
        <span className="wp-scope-name">
          {fileId ? (selected.data?.originalName ?? '所选文档') : '全部文档'}
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="wp-scope-menu" role="region" aria-label="选择检索范围">
        <button
          className="wp-scope-item"
          type="button"
          onClick={() => choose('')}
          aria-pressed={!fileId}
        >
          <Files aria-hidden="true" />
          全部文档
          {!fileId && <Check className="wp-check" aria-hidden="true" />}
        </button>
        <label className="wp-file-filter">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="按文件名筛选范围"
            placeholder="按文件名筛选"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(1);
            }}
          />
        </label>
        {files.loading && (
          <p className="wp-menu-note" role="status">
            正在读取文件…
          </p>
        )}
        {files.error && (
          <div className="wp-menu-note" role="alert">
            <p>{files.error}</p>
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              重试
            </button>
          </div>
        )}
        {files.data?.items.map((file) => (
          <button
            className="wp-scope-item"
            key={file.id}
            type="button"
            onClick={() => choose(file.id)}
            aria-pressed={fileId === file.id}
          >
            <DocumentIcon name={file.originalName} />
            <span>{file.originalName}</span>
            {fileId === file.id && (
              <Check className="wp-check" aria-hidden="true" />
            )}
          </button>
        ))}
        {files.data && !files.data.items.length && (
          <p className="wp-menu-note">没有符合条件的文件</p>
        )}
        {files.data && files.data.totalPages > 1 && (
          <div className="wp-scope-pagination">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              aria-label="文件范围上一页"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span>
              {page} / {files.data.totalPages}
            </span>
            <button
              type="button"
              disabled={page >= files.data.totalPages}
              onClick={() => setPage(page + 1)}
              aria-label="文件范围下一页"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function WorkbenchSearch({
  query,
  mode,
  fileId,
  onSearch,
  onScope,
}: {
  query: string;
  mode: Mode;
  fileId: string;
  onSearch: (query: string, mode: Mode) => void;
  onScope: (id: string) => void;
}) {
  const [draft, setDraft] = useState(query);
  const [draftMode, setDraftMode] = useState(mode);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(query);
    setDraftMode(mode);
    setError('');
  }, [query, mode]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    const limit = draftMode === 'literal' ? 100 : 1000;
    if (!value || Array.from(value).length > limit) {
      setError(`请输入 1–${limit} 个字符`);
      return;
    }
    setError('');
    onSearch(value, draftMode);
  }

  return (
    <>
      <form className="wp-search" id="wp-search" onSubmit={submit}>
        <label className="wp-searchbox">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="检索内容"
            placeholder={
              draftMode === 'literal' ? '输入关键词' : '输入问题或描述'
            }
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError('');
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'wp-query-error' : undefined}
          />
          <kbd aria-hidden="true">
            <CornerDownLeft />
          </kbd>
        </label>
        <button className="wp-search-button" type="submit">
          检索 <ArrowRight aria-hidden="true" />
        </button>
      </form>
      <div className="wp-search-options">
        <fieldset className="wp-modes">
          <legend className="sr-only">检索模式</legend>
          {(['literal', 'semantic'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                form="wp-search"
                name="wp-mode"
                checked={draftMode === value}
                onChange={() => {
                  setDraftMode(value);
                  setError('');
                }}
              />
              {value === 'literal' ? '关键词检索' : '语义检索'}
            </label>
          ))}
        </fieldset>
        <ScopePicker fileId={fileId} onChange={onScope} />
        <span className="wp-option-note">点击结果，核对对应切片与出处</span>
      </div>
      {error && (
        <p className="wp-error" id="wp-query-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function Inspector({ hit }: { hit?: Hit }) {
  const [copyState, setCopyState] = useState('');
  const source = hit ? sourceLabel(hit.source) : null;

  useEffect(() => {
    if (!copyState) return;
    const timer = setTimeout(() => setCopyState(''), 3000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyCitation() {
    if (!hit) return;
    const text = [
      hit.file.originalName,
      source,
      `切片 ${hit.index + 1}`,
      `字符区间 [${hit.startOffset}, ${hit.endOffset})`,
    ]
      .filter(Boolean)
      .join(' · ');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('已复制出处');
    } catch {
      setCopyState('复制失败，请手动选择出处');
    }
  }

  return (
    <section
      className="wp-panel wp-inspector"
      aria-labelledby="wp-inspector-title"
      id="wp-inspector"
      tabIndex={0}
    >
      <div className="wp-panel-head">
        <h2 id="wp-inspector-title">
          <TextQuote aria-hidden="true" />
          切片核对
        </h2>
        <span className="wp-meta">{hit ? '当前选中结果' : '来源与原文'}</span>
      </div>
      {hit ? (
        <>
          <div className="wp-document-title">
            <span className="wp-document-mark">
              <DocumentIcon name={hit.file.originalName} />
            </span>
            <div>
              <h3>{hit.file.originalName}</h3>
              <p>
                <span className="wp-filetype">
                  {fileType(hit.file.originalName)}
                </span>
                来源文档
              </p>
            </div>
          </div>
          <div className="wp-coordinates">
            {source && (
              <span className="wp-coordinate">
                <span>来源</span>
                <b>{source}</b>
              </span>
            )}
            <span className="wp-coordinate">
              <span>切片</span>
              <b>{hit.index + 1}</b>
            </span>
            <span className="wp-coordinate">
              <span>字符</span>
              <b>{Array.from(hit.content).length}</b>
            </span>
            <button className="wp-copy" onClick={() => void copyCitation()}>
              {copyState === '已复制出处' ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              复制出处
            </button>
          </div>
          {copyState && (
            <p className="wp-copy-status" role="status">
              {copyState}
            </p>
          )}
          <div className="wp-reading">
            <div className="wp-reading-heading">
              <span>提取原文</span>
              <span className="wp-offset">
                [{hit.startOffset}, {hit.endOffset})
              </span>
            </div>
            <PassageText
              content={hit.content}
              matches={'matches' in hit ? hit.matches : undefined}
            />
          </div>
          <div className="wp-source-footer">
            <Link to={`${filePath(hit.file.id)}?chunk=${hit.index + 1}`}>
              打开文件详情 <ArrowRight aria-hidden="true" />
            </Link>
            <span>{source ?? '按提取文本字符定位'}</span>
          </div>
        </>
      ) : (
        <div className="wp-empty wp-inspector-empty">
          <BookOpen aria-hidden="true" />
          <h3>在这里核对原文</h3>
          <p>选择一条检索结果，查看完整切片、来源位置和命中内容</p>
        </div>
      )}
    </section>
  );
}

export function SearchWorkbench() {
  const [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<{ key: string; id: string }>();
  const resultsColumn = useRef<HTMLElement>(null);
  const query = params.get('q')?.trim() ?? '';
  const mode: Mode = params.get('mode') === 'semantic' ? 'semantic' : 'literal';
  const fileId = params.get('file') ?? '';
  const page = pageNumber(params.get('page'));
  const apiQuery = new URLSearchParams({ q: query, limit: String(PAGE_SIZE) });
  if (mode === 'literal') apiQuery.set('page', String(page));
  if (fileId) apiQuery.set('fileId', fileId);
  const path = query
    ? `/search${mode === 'semantic' ? '/semantic' : ''}?${apiQuery}`
    : null;
  const { data, loading, error } = useResource<SearchResponse>(path, refresh);
  const key = `${refresh}:${path}`;
  const active =
    data?.items.find(
      (hit) => selection?.key === key && selection.id === hit.chunkId,
    ) ?? data?.items[0];

  function search(
    nextQuery: string,
    nextMode: Mode,
    nextPage = 1,
    nextFile = fileId,
  ) {
    const next = new URLSearchParams();
    if (nextQuery) next.set('q', nextQuery);
    next.set('mode', nextMode);
    if (nextFile) next.set('file', nextFile);
    if (nextMode === 'literal' && nextPage > 1)
      next.set('page', String(nextPage));
    if (next.toString() === params.toString()) setRefresh((value) => value + 1);
    else setParams(next);
  }

  function movePage(nextPage: number) {
    resultsColumn.current?.focus({ preventScroll: true });
    resultsColumn.current?.scrollIntoView({ block: 'start' });
    search(query, mode, nextPage);
  }

  return (
    <>
      <div className="wp-page-heading">
        <h1>文档检索</h1>
        <span>
          <Files aria-hidden="true" />
          {DEMO_MODE ? '样本文档集' : '个人文档集'}
        </span>
      </div>
      <div className="wp-query-panel">
        <WorkbenchSearch
          query={query}
          mode={mode}
          fileId={fileId}
          onSearch={search}
          onScope={(id) => search(query, mode, 1, id)}
        />
        {DEMO_MODE && (
          <div className="wp-demo-guide">
            <p>关键词可自由输入，语义示例展示预设结果。</p>
            <div className="wp-demo-queries" role="group" aria-label="示例查询">
              <button
                type="button"
                className="button secondary"
                onClick={() => search(DEMO_KEYWORD, 'literal', 1, '')}
              >
                <span>关键词示例</span> {DEMO_KEYWORD}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => search(DEMO_QUESTION, 'semantic', 1, '')}
              >
                <span>语义示例</span> {DEMO_QUESTION}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="wp-workspace">
        <section
          ref={resultsColumn}
          className="wp-results-column"
          aria-labelledby="wp-results-title"
          tabIndex={-1}
        >
          <div className="wp-panel" aria-busy={loading}>
            <div className="wp-panel-head">
              <h2 id="wp-results-title">检索结果</h2>
              <span className="wp-result-count" role="status">
                {data ? (
                  data.mode === 'literal' ? (
                    <>
                      <span className="wp-number">{data.total}</span> 条命中
                    </>
                  ) : (
                    <>
                      <span className="wp-number">{data.returned}</span> 条返回
                    </>
                  )
                ) : (
                  ''
                )}
              </span>
              <span className="wp-result-mode">
                {mode === 'literal'
                  ? '关键词模式'
                  : DEMO_MODE
                    ? '语义示例'
                    : '语义模式'}
              </span>
            </div>
            {!query && (
              <div className="wp-empty">
                <Search aria-hidden="true" />
                <h3>从一个关键词开始</h3>
                <p>
                  {DEMO_MODE
                    ? '在内置样本文档里查找词语，或试试上方的语义示例'
                    : '检索已处理的文档，保留每条结果的原文与出处'}
                </p>
                <Link to="/files">
                  {DEMO_MODE ? '浏览样本文档' : '上传与管理文件'}{' '}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </div>
            )}
            {loading && (
              <div className="wp-empty" role="status">
                <p>正在检索文档…</p>
              </div>
            )}
            {error && (
              <div className="wp-empty wp-request-error" role="alert">
                <h3>检索未完成</h3>
                <p>{error}</p>
                <button onClick={() => setRefresh((value) => value + 1)}>
                  重新检索 <ArrowRight aria-hidden="true" />
                </button>
              </div>
            )}
            {data && !data.items.length && (
              <div className="wp-empty">
                <Search aria-hidden="true" />
                <h3>没有找到匹配内容</h3>
                <p>
                  {DEMO_MODE
                    ? mode === 'semantic'
                      ? '选择上方的语义示例，或切换到关键词检索输入自己的查询'
                      : '换一个词，或将检索范围切换为全部文档'
                    : '试试其他查询词，或到文件库确认文档是否已完成处理'}
                </p>
                {data.mode === 'literal' && data.page > 1 && (
                  <button onClick={() => movePage(1)}>返回第一页</button>
                )}
              </div>
            )}
            {data && data.items.length > 0 && (
              <ol className="wp-results-list">
                {data.items.map((hit, index) => {
                  const selected = hit.chunkId === active?.chunkId;
                  return (
                    <li
                      key={hit.chunkId}
                      className={`wp-result${selected ? ' wp-selected' : ''}`}
                    >
                      <button
                        className="wp-result-select"
                        aria-pressed={selected}
                        aria-controls="wp-inspector"
                        aria-label={[
                          hit.file.originalName,
                          sourceLabel(hit.source),
                          `切片 ${hit.index + 1}`,
                        ]
                          .filter(Boolean)
                          .join('，')}
                        onClick={() => setSelection({ key, id: hit.chunkId })}
                      >
                        <span className="wp-rank">
                          {(data.mode === 'literal'
                            ? (data.page - 1) * data.limit
                            : 0) +
                            index +
                            1}
                        </span>
                        <span className="wp-result-title">
                          <span className="wp-file-mark">
                            <DocumentIcon name={hit.file.originalName} />
                          </span>
                          <span
                            className="wp-filename"
                            title={hit.file.originalName}
                          >
                            {hit.file.originalName}
                          </span>
                          <span className="wp-filetype">
                            {fileType(hit.file.originalName)}
                          </span>
                        </span>
                        <span className="wp-result-meta">
                          <span className="wp-locator">
                            <MapPin aria-hidden="true" />
                            {sourceLabel(hit.source)
                              ? `${sourceLabel(hit.source)} · `
                              : ''}
                            切片 {hit.index + 1}
                          </span>
                          <span>
                            字符{' '}
                            <span className="wp-number">
                              {hit.startOffset}–{hit.endOffset}
                            </span>
                          </span>
                        </span>
                      </button>
                      <div className="wp-result-content">
                        <PassageText
                          content={hit.content}
                          matches={'matches' in hit ? hit.matches : undefined}
                        />
                        <div className="wp-result-bottom">
                          {selected ? (
                            <a
                              href="#wp-inspector"
                              className="wp-selected-note"
                              onClick={DEMO_MODE ? jumpToPageAnchor : undefined}
                            >
                              <Eye aria-hidden="true" />
                              核对选中原文
                            </a>
                          ) : (
                            <button
                              onClick={() =>
                                setSelection({ key, id: hit.chunkId })
                              }
                            >
                              查看切片
                            </button>
                          )}
                          {'score' in hit && (
                            <span className="wp-score" title="余弦相似度">
                              相似度{' '}
                              <span className="wp-number">
                                {hit.score.toFixed(3)}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {data && data.items.length > 0 && (
              <div className="wp-list-footer">
                <span>
                  {data.mode === 'literal'
                    ? `显示 ${(data.page - 1) * data.limit + 1}–${(data.page - 1) * data.limit + data.items.length} 条，共 ${data.total} 条`
                    : `返回 ${data.returned} 条，最多 ${data.limit} 条`}
                </span>
                {data.mode === 'literal' && (
                  <nav className="wp-page-buttons" aria-label="结果分页">
                    <button
                      disabled={data.page <= 1}
                      aria-label="上一页"
                      onClick={() => movePage(data.page - 1)}
                    >
                      <ChevronLeft aria-hidden="true" />
                    </button>
                    <span>
                      {data.page} / {Math.max(1, data.totalPages)}
                    </span>
                    <button
                      disabled={
                        data.page >= data.totalPages || data.page >= 10000
                      }
                      aria-label="下一页"
                      onClick={() => movePage(data.page + 1)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </nav>
                )}
              </div>
            )}
          </div>
          <p className="wp-list-note">
            <Info aria-hidden="true" />
            {mode === 'literal'
              ? '高亮表示当前查询的文字匹配位置'
              : DEMO_MODE
                ? '这是预设的语义检索示例，请结合原文核对相关性'
                : '相似度用于排序，请结合原文判断相关性'}
          </p>
          {data?.mode === 'semantic' && 'model' in data && (
            <p className="wp-model-meta">
              {data.model} · {data.dimensions} 维 · {data.metric}
            </p>
          )}
        </section>
        <Inspector hit={active} key={`${key}:${active?.chunkId ?? ''}`} />
      </div>
    </>
  );
}
