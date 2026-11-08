import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import {
  PAGE_SIZE,
  errorMessage,
  filePath,
  pageNumber,
  request,
  sourceLabel,
} from './api';
import type { Chunk, FileRecord, Page, ProcessingJob } from './api';
import { ChunkVectorInspection } from './ChunkVectorInspection';
import { DEMO_MODE } from './demo';
import { FileDeleteAction } from './FileDeleteAction';
import {
  DocumentIcon,
  Empty,
  IndexBadge,
  IndexTime,
  Loading,
  Notice,
  Pagination,
  PassageText,
  fileDate,
  fileSize,
  fileType,
} from './ui';
import { isFinished, useResource } from './use-resource';

const stillRunning = (job: ProcessingJob) => !isFinished(job);
const jobLabels: Record<string, string> = {
  waiting: '排队中',
  delayed: '等待重试',
  prioritized: '排队中',
  paused: '队列已暂停',
  active: '正在处理文档',
  completed: '索引已完成',
  failed: '任务处理失败',
};

const stages = [
  ['queued', '排队'],
  ['reading', '读取原件'],
  ['extracting', '提取文本与切片'],
  ['embedding', '生成向量'],
  ['indexing', '写入索引'],
] as const;

function FileTitle({ name }: { name: string }) {
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const heading = title.current;
    if (!heading || expanded) return;
    const measure = () =>
      setClipped(heading.scrollHeight > heading.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    measure();
    return () => observer.disconnect();
  }, [expanded, name]);

  return (
    <>
      <h1
        ref={title}
        id={id}
        className="file-title"
        data-expanded={expanded}
        dir="auto"
      >
        {name}
      </h1>
      {clipped && (
        <button
          className="text-action file-title-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起文件名' : '展开文件名'}
        </button>
      )}
    </>
  );
}

function JobProgress({ job }: { job: ProcessingJob }) {
  const finished = job.state === 'completed';
  const failed = job.state === 'failed';
  const queued = job.state !== 'active' && !finished && !failed;
  const stageIndex = queued
    ? 0
    : stages.findIndex(([phase]) => phase === job.phase);
  const stalled = failed && job.error?.includes('stalled');
  return (
    <section className="wp-panel job-progress" aria-label="处理进度">
      <div className="wp-panel-head" role="status">
        <h2>{jobLabels[job.state] ?? '等待任务状态'}</h2>
        {job.attemptsMade > 0 && !finished && (
          <span className="wp-meta">已尝试 {job.attemptsMade} 次</span>
        )}
      </div>
      <ol className="job-stages">
        {stages.map(([phase, label], index) => {
          const status =
            finished || index < stageIndex
              ? 'done'
              : index === stageIndex
                ? failed
                  ? 'failed'
                  : 'current'
                : 'pending';
          return (
            <li
              key={phase}
              data-stage={status}
              aria-current={status === 'current' ? 'step' : undefined}
            >
              <span className="job-stage-number wp-number">{index + 1}</span>
              {label}
              <span className="sr-only">
                {status === 'done'
                  ? '，已完成'
                  : status === 'failed'
                    ? '，失败'
                    : status === 'pending'
                      ? '，待处理'
                      : ''}
              </span>
            </li>
          );
        })}
      </ol>
      {failed && job.error && (
        <p className="job-message" role="alert">
          {stalled
            ? '后台 Worker 多次中断或失去任务锁。请确认 Worker 和 Redis 正常运行后重试。'
            : job.error}
        </p>
      )}
      {job.result && (
        <p className="job-message">
          {job.result.chunkCount} 个切片 · {job.result.model} ·{' '}
          {job.result.dimensions} 维
        </p>
      )}
    </section>
  );
}

function FileRecordPage({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const [refresh, setRefresh] = useState(0);
  const [jobRefresh, setJobRefresh] = useState(0);
  const [startedJobId, setStartedJobId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const startController = useRef<AbortController | null>(null);
  const refreshedJob = useRef<string>(undefined);
  const path = filePath(id);
  const chunkNumber = Number(params.get('chunk'));
  const requestedPage =
    Number.isSafeInteger(chunkNumber) && chunkNumber > 0
      ? Math.floor((chunkNumber - 1) / PAGE_SIZE) + 1
      : 1;
  const page = pageNumber(params.get('page') ?? String(requestedPage));
  const file = useResource<FileRecord>(path, refresh);
  const jobId = DEMO_MODE
    ? null
    : (startedJobId ?? file.data?.processingJob?.jobId ?? params.get('job'));
  const chunks = useResource<Page<Chunk>>(
    `${path}/chunks?page=${page}&limit=${PAGE_SIZE}`,
    refresh,
  );
  const job = useResource<ProcessingJob>(
    jobId ? `${path}/processing-jobs/${encodeURIComponent(jobId)}` : null,
    jobRefresh,
    stillRunning,
  );
  const finished = isFinished(job.data);
  const processing = Boolean(jobId && !job.error && !finished);

  useEffect(() => () => startController.current?.abort(), []);

  useEffect(() => {
    if (!finished || !jobId || !file.data || refreshedJob.current === jobId)
      return;
    refreshedJob.current = jobId;
    const initialJob = file.data.processingJob;
    if (initialJob?.jobId !== jobId || !isFinished(initialJob))
      setRefresh((value) => value + 1);
  }, [file.data, finished, jobId]);

  useEffect(() => {
    if (chunks.data && chunkNumber > 0)
      document
        .getElementById(`chunk-${chunkNumber}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [chunks.data, chunkNumber]);

  async function start() {
    if (startController.current) return;
    const controller = new AbortController();
    startController.current = controller;
    setStarting(true);
    setStartError('');
    try {
      const next = await request<{ jobId: string }>(`${path}/process`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStartedJobId(next.jobId);
      setJobRefresh((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setStartError(errorMessage(error));
    } finally {
      startController.current = null;
      if (!controller.signal.aborted) setStarting(false);
    }
  }

  function move(nextPage: number) {
    const next = new URLSearchParams(params);
    next.delete('chunk');
    if (nextPage === 1) next.delete('page');
    else next.set('page', String(nextPage));
    setParams(next);
  }

  return (
    <>
      <Link className="back-link" to="/files">
        <ArrowLeft aria-hidden="true" />
        返回文件库
      </Link>
      {file.loading && <Loading label="正在读取文件详情…" />}
      {file.error && (
        <Notice onRetry={() => setRefresh((value) => value + 1)}>
          {file.error}
        </Notice>
      )}
      {file.data && (
        <>
          <div className="wp-panel wp-page-heading heading-actions detail-heading">
            <div className="file-identity">
              <span className="wp-document-mark">
                <DocumentIcon name={file.data.originalName} />
              </span>
              <div>
                <FileTitle name={file.data.originalName} />
                <div className="detail-meta">
                  <span className="wp-filetype">
                    {fileType(file.data.originalName)}
                  </span>
                  <IndexBadge
                    status={file.data.indexStatus}
                    jobState={job.data?.state ?? file.data.processingJob?.state}
                  />
                  <span>{fileSize(file.data.sizeBytes)}</span>
                  <span className="detail-date">
                    {DEMO_MODE ? '收录于' : '上传于'}{' '}
                    <time dateTime={file.data.createdAt}>
                      {fileDate(file.data.createdAt)}
                    </time>
                  </span>
                  {file.data.indexedAt && (
                    <span className="detail-date">
                      索引于 <IndexTime value={file.data.indexedAt} />
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="detail-actions">
              <a
                className="button secondary"
                href={
                  DEMO_MODE ? file.data.demoDownloadUrl : `/api${path}/download`
                }
                download={DEMO_MODE ? file.data.originalName : undefined}
              >
                <ArrowDownToLine aria-hidden="true" />
                下载原件
              </a>
              {!DEMO_MODE && (
                <>
                  <button
                    type="button"
                    className="button primary"
                    disabled={starting || processing}
                    onClick={() => void start()}
                  >
                    <RefreshCw aria-hidden="true" />
                    {starting
                      ? '正在提交…'
                      : processing
                        ? '处理中…'
                        : job.data?.state === 'failed'
                          ? '重试处理'
                          : file.data.indexStatus === 'READY'
                            ? '重新索引'
                            : '开始处理'}
                  </button>
                  <FileDeleteAction
                    fileName={file.data.originalName}
                    path={path}
                    blocked={
                      starting ||
                      processing ||
                      file.data.indexStatus === 'PROCESSING' ||
                      Boolean(
                        file.data.processingJob &&
                        !isFinished(file.data.processingJob),
                      )
                    }
                  />
                </>
              )}
            </div>
          </div>
          {startError && <Notice>{startError}</Notice>}
          {job.error && (
            <Notice onRetry={() => setJobRefresh((value) => value + 1)}>
              读取处理状态失败。{job.error}
            </Notice>
          )}
          {job.loading && (
            <p className="feedback" role="status">
              正在读取处理状态…
            </p>
          )}
          {job.data && <JobProgress job={job.data} />}
          <section
            className="wp-panel"
            aria-labelledby="chunks-title"
            aria-busy={chunks.loading}
          >
            <div className="wp-panel-head chunks-heading">
              <h2 id="chunks-title">
                切片原文
                {chunks.data && (
                  <span className="count">{chunks.data.total}</span>
                )}
              </h2>
              <Link to={`/?file=${encodeURIComponent(id)}`}>
                在此文件中检索
                <ArrowRight aria-hidden="true" />
              </Link>
            </div>
            {chunks.loading && <Loading label="正在读取切片…" />}
            {chunks.error && (
              <Notice onRetry={() => setRefresh((value) => value + 1)}>
                {chunks.error}
              </Notice>
            )}
            {chunks.data?.items.length === 0 && (
              <Empty title="这一页没有切片">
                处理完成后，提取的段落会显示在这里。
              </Empty>
            )}
            {chunks.data && (
              <>
                <ol className="chunk-list">
                  {chunks.data.items.map((chunk) => (
                    <li
                      key={chunk.id}
                      id={`chunk-${chunk.index + 1}`}
                      className={
                        chunk.index + 1 === chunkNumber
                          ? 'chunk selected-chunk'
                          : 'chunk'
                      }
                    >
                      <div className="chunk-heading">
                        <h3>切片 {chunk.index + 1}</h3>
                        <span>{sourceLabel(chunk.source)}</span>
                      </div>
                      <p className="passage-meta">
                        字符区间 [{chunk.startOffset}, {chunk.endOffset})
                      </p>
                      <PassageText content={chunk.content} />
                      {file.data?.indexStatus === 'READY' && (
                        <ChunkVectorInspection
                          key={file.data.indexedAt}
                          fileId={id}
                          chunkId={chunk.id}
                        />
                      )}
                    </li>
                  ))}
                </ol>
                <Pagination
                  page={chunks.data.page}
                  totalPages={chunks.data.totalPages}
                  onPage={move}
                />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function FileDetail() {
  const { id = '' } = useParams();
  return <FileRecordPage key={id} id={id} />;
}
