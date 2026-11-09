import { useState } from 'react';

import { chunkVectorPath } from './api';
import type { ChunkVector } from './api';
import { Loading, Notice } from './ui';
import { useResource } from './use-resource';

const PREVIEW_DIMENSIONS = 32;

export function ChunkVectorInspection({
  fileId,
  chunkId,
}: {
  fileId: string;
  chunkId: string;
}) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const { data, loading, error } = useResource<ChunkVector>(
    open ? chunkVectorPath(fileId, chunkId) : null,
    refresh,
  );
  const preview = data?.vector.slice(0, PREVIEW_DIMENSIONS) ?? [];
  const scale = Math.max(0, ...preview.map(Math.abs)) || 1;

  async function copyVector() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data.vector));
      setCopyStatus('已复制完整向量');
    } catch {
      setCopyStatus('复制失败，请检查浏览器剪贴板权限');
    }
  }

  return (
    <details
      className="vector-inspection"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        setCopyStatus('');
      }}
    >
      <summary>查看切片向量</summary>
      {loading && <Loading label="正在读取向量…" />}
      {error && (
        <Notice onRetry={() => setRefresh((value) => value + 1)}>
          {error}
        </Notice>
      )}
      {data && (
        <div className="vector-inspection-body">
          <dl className="vector-facts">
            <div>
              <dt>{'example' in data ? '数据来源' : '模型'}</dt>
              <dd>{'example' in data ? '演示向量' : data.model}</dd>
            </div>
            <div>
              <dt>维度</dt>
              <dd>{data.dimensions}</dd>
            </div>
            {'collection' in data && (
              <div>
                <dt>集合</dt>
                <dd>{data.collection}</dd>
              </div>
            )}
          </dl>
          <figure className="vector-preview">
            <svg
              viewBox={`0 0 ${preview.length * 10} 60`}
              preserveAspectRatio="none"
              role="img"
              aria-label="向量分量预览"
            >
              <line x1="0" x2={preview.length * 10} y1="30" y2="30" />
              {preview.map((value, index) => {
                const height = (Math.abs(value) / scale) * 26;
                return (
                  <rect
                    key={index}
                    x={index * 10 + 2}
                    y={value < 0 ? 30 : 30 - height}
                    width="6"
                    height={height}
                    data-negative={value < 0}
                  >
                    <title>{`第 ${index + 1} 维：${value}`}</title>
                  </rect>
                );
              })}
            </svg>
            <figcaption>
              第 1–{preview.length} 维，共 {data.dimensions} 维 · 以 0 为基线
            </figcaption>
          </figure>
          <div className="vector-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => void copyVector()}
            >
              复制完整向量
            </button>
            <span role="status">{copyStatus}</span>
          </div>
        </div>
      )}
    </details>
  );
}
