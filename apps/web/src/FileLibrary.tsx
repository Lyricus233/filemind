import { ArrowUpToLine, ChevronRight, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { PAGE_SIZE, errorMessage, filePath, pageNumber, request } from './api';
import type { FileRecord, Page } from './api';
import { DEMO_MODE } from './demo';
import {
  DocumentIcon,
  Empty,
  IndexBadge,
  IndexTime,
  Loading,
  Notice,
  Pagination,
  fileDate,
  fileSize,
  fileType,
} from './ui';
import { isFinished, useResource } from './use-resource';

const hasRunningJobs = (page: Page<FileRecord>) =>
  page.items.some(
    ({ processingJob }) => processingJob && !isFinished(processingJob),
  );

function NameFilter({
  name,
  onFilter,
}: {
  name: string;
  onFilter: (name: string) => void;
}) {
  const [value, setValue] = useState(name);

  function submit(event: FormEvent) {
    event.preventDefault();
    onFilter(value.trim());
  }

  return (
    <form className="name-filter" onSubmit={submit}>
      <label>
        <Search aria-hidden="true" />
        <span className="sr-only">文件名</span>
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={255}
          placeholder="按文件名查找"
        />
      </label>
      <button className="button secondary" type="submit">
        筛选
      </button>
      {name && (
        <button
          className="text-action"
          type="button"
          onClick={() => onFilter('')}
        >
          清除
        </button>
      )}
    </form>
  );
}

export function FileLibrary() {
  const [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{
    count: number;
    errors: string[];
  }>();
  const input = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const page = pageNumber(params.get('page'));
  const name = params.get('name') ?? '';
  const query = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  if (name) query.set('name', name);
  const { data, error, loading } = useResource<Page<FileRecord>>(
    `/files?${query}`,
    refresh,
    hasRunningJobs,
  );

  useEffect(() => () => uploadController.current?.abort(), []);

  function show(nextName: string, nextPage = 1) {
    const next = new URLSearchParams();
    if (nextName) next.set('name', nextName);
    if (nextPage > 1) next.set('page', String(nextPage));
    setParams(next);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!files.length || uploadController.current) return;

    const controller = new AbortController();
    uploadController.current = controller;

    let count = 0;
    const errors: string[] = [];
    setUploadSummary(undefined);
    for (const [index, file] of files.entries()) {
      setUploadProgress(`正在上传 ${index + 1} / ${files.length}`);
      if (!/\.(txt|md|pdf|docx)$/iu.test(file.name)) {
        errors.push(`${file.name} · 请选择 TXT、Markdown、PDF 或 DOCX。`);
        continue;
      }
      if (file.size > 10 * 1024 ** 2) {
        errors.push(`${file.name} · 文件超过 10 MiB。`);
        continue;
      }
      const body = new FormData();
      body.append('file', file);
      try {
        await request<FileRecord>('/files', {
          method: 'POST',
          body,
          signal: controller.signal,
        });
        count++;
      } catch (error) {
        if (controller.signal.aborted) return;
        errors.push(`${file.name} · ${errorMessage(error)}`);
      }
      if (controller.signal.aborted) return;
    }
    uploadController.current = null;
    setUploadProgress(null);
    setUploadSummary({ count, errors });
    if (count) {
      show('');
      setRefresh((value) => value + 1);
    }
  }

  return (
    <>
      <div className="wp-page-heading heading-actions">
        <div>
          <h1>文件库</h1>
          <p>
            {DEMO_MODE
              ? '打开样本文档查看切片，或下载原文。'
              : '上传文档后，在文件详情中开始索引和查看切片。'}
          </p>
        </div>
        {!DEMO_MODE && (
          <div className="upload-actions">
            <input
              ref={input}
              hidden
              type="file"
              multiple
              accept=".txt,.md,.pdf,.docx"
              onChange={(event) => void upload(event)}
            />
            <button
              type="button"
              className="button primary"
              onClick={() => input.current?.click()}
              disabled={Boolean(uploadProgress)}
            >
              <ArrowUpToLine aria-hidden="true" />
              上传文件
            </button>
            <span>TXT、MD、PDF、DOCX · 单个 ≤ 10 MiB</span>
          </div>
        )}
      </div>
      {uploadProgress && (
        <p className="feedback" role="status">
          {uploadProgress}
        </p>
      )}
      {uploadSummary && (
        <div className="upload-summary">
          {uploadSummary.count > 0 && (
            <p className="feedback" role="status">
              已上传 {uploadSummary.count} 个文件。打开文件详情即可开始处理。
            </p>
          )}
          {uploadSummary.errors.length > 0 && (
            <Notice>
              <strong>{uploadSummary.errors.length} 个文件上传失败</strong>
              <ul>
                {uploadSummary.errors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
      )}
      <section
        className="wp-panel"
        aria-labelledby="library-title"
        aria-busy={loading}
      >
        <div className="wp-panel-head library-heading">
          <h2 id="library-title">
            文档{data && <span className="count">{data.total}</span>}
          </h2>
          <NameFilter key={name} name={name} onFilter={show} />
        </div>
        {loading && <Loading label="正在读取文件…" />}
        {error && (
          <Notice onRetry={() => setRefresh((value) => value + 1)}>
            {error}
          </Notice>
        )}
        {data && data.items.length === 0 && (
          <Empty title={name ? '没有匹配的文件' : '文件库还没有文档'}>
            {name
              ? '清除筛选，或换一个文件名试试。'
              : '选择一个文档上传，接着在详情页开始处理。'}
          </Empty>
        )}
        {data && data.items.length > 0 && (
          <div className="file-register">
            <div className="file-columns" aria-hidden="true">
              <span>文件名</span>
              <span>索引状态</span>
              <span>大小</span>
              <span>{DEMO_MODE ? '收录日期' : '上传日期'}</span>
              <span>索引完成时间</span>
              <span />
            </div>
            <ul>
              {data.items.map((file) => (
                <li key={file.id}>
                  <Link className="file-row" to={filePath(file.id)}>
                    <span className="file-name">
                      <span className="wp-document-mark">
                        <DocumentIcon name={file.originalName} />
                      </span>
                      <strong title={file.originalName} dir="auto">
                        {file.originalName}
                      </strong>
                      <span className="wp-filetype">
                        {fileType(file.originalName)}
                      </span>
                    </span>
                    <IndexBadge
                      status={file.indexStatus}
                      jobState={file.processingJob?.state}
                    />
                    <span className="file-size">
                      {fileSize(file.sizeBytes)}
                    </span>
                    <time className="file-uploaded" dateTime={file.createdAt}>
                      {fileDate(file.createdAt)}
                    </time>
                    <span className="file-indexed" data-empty={!file.indexedAt}>
                      {file.indexedAt ? (
                        <>
                          <span className="file-indexed-label">索引于 </span>
                          <IndexTime value={file.indexedAt} />
                        </>
                      ) : (
                        <span aria-label="尚未完成索引">—</span>
                      )}
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data && (
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            onPage={(next) => show(name, next)}
          />
        )}
      </section>
    </>
  );
}
