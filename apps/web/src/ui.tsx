import { FileCode2, FileText, FileType2 } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import type { IndexStatus, MatchRange } from './api';

export function jumpToPageAnchor(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const target = document.getElementById(event.currentTarget.hash.slice(1));
  target?.focus({ preventScroll: true });
  target?.scrollIntoView();
}

export function fileType(name: string) {
  const extension = name.split('.').pop()?.toUpperCase();
  return extension && ['PDF', 'DOCX', 'MD', 'TXT'].includes(extension)
    ? extension
    : '文档';
}

export function DocumentIcon({ name }: { name: string }) {
  const format = fileType(name);
  const Icon =
    format === 'MD' ? FileCode2 : format === 'DOCX' ? FileType2 : FileText;
  return <Icon aria-hidden="true" />;
}

const labels: Record<IndexStatus, string> = {
  PENDING: '待处理',
  PROCESSING: '处理中',
  READY: '已索引',
  FAILED: '处理失败',
};

export function IndexBadge({
  status,
  jobState,
}: {
  status: IndexStatus;
  jobState?: string;
}) {
  const display =
    jobState === 'failed'
      ? 'FAILED'
      : jobState === 'active'
        ? 'PROCESSING'
        : jobState === 'completed'
          ? 'READY'
          : status;
  const label =
    jobState === 'delayed'
      ? '等待重试'
      : jobState === 'waiting' ||
          jobState === 'prioritized' ||
          jobState === 'paused'
        ? '排队中'
        : labels[display];
  return (
    <span className={`status-pill ${display.toLowerCase()}`}>{label}</span>
  );
}

export function fileSize(value: string) {
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function fileDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(
    new Date(value),
  );
}

const indexTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function IndexTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>{indexTimeFormat.format(new Date(value))}</time>
  );
}

export function Notice({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="notice" role="alert">
      <div>{children}</div>
      {onRetry && (
        <button className="text-action" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="loading-state" role="status">
      {label}
    </p>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (totalPages < 2 && page === 1) return null;
  const lastPage = Math.max(1, Math.min(totalPages, 10_000));
  return (
    <nav className="pagination" aria-label="分页">
      <button
        className="button secondary"
        disabled={page <= 1}
        onClick={() => onPage(Math.max(1, Math.min(page - 1, lastPage)))}
      >
        上一页
      </button>
      <span>
        第 {page} 页 / 共 {lastPage} 页
      </span>
      <button
        className="button secondary"
        disabled={page >= lastPage}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}

export function PassageText({
  content,
  matches = [],
}: {
  content: string;
  matches?: MatchRange[];
}) {
  if (!matches.length) return <p className="passage">{content}</p>;
  const characters = Array.from(content);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end } of matches) {
    parts.push(characters.slice(cursor, start).join(''));
    parts.push(
      <mark key={start}>{characters.slice(start, end).join('')}</mark>,
    );
    cursor = end;
  }
  parts.push(characters.slice(cursor).join(''));
  return <p className="passage">{parts}</p>;
}
