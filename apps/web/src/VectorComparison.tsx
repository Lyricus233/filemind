import { ChevronLeft, Grid2X2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { chunkVectorPath, errorMessage, request } from './api';
import type { ChunkVector, SearchHit } from './api';
import { DEMO_MODE } from './demo';
import { Notice } from './ui';

export const MAX_VECTOR_COMPARISON = 4;
export type ComparedChunk = Pick<SearchHit, 'chunkId' | 'file' | 'index'>;

function cosine(left: ChunkVector, right: ChunkVector): number | null {
  if (
    left.dimensions !== right.dimensions ||
    left.vector.length !== left.dimensions ||
    right.vector.length !== right.dimensions
  )
    return null;

  const sameSpace =
    'example' in left
      ? 'example' in right
      : 'collection' in right &&
        left.collection === right.collection &&
        left.model === right.model;
  if (!sameSpace) return null;

  let dot = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.vector.length; index += 1) {
    const a = left.vector[index];
    const b = right.vector[index];
    dot += a * b;
    leftSquare += a * a;
    rightSquare += b * b;
  }
  const score = dot / (Math.sqrt(leftSquare) * Math.sqrt(rightSquare));
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null;
}

type Result = { scores: (number | null)[][] } | { error: string };

function highestPair(scores: (number | null)[][]) {
  let best: { row: number; column: number; score: number } | undefined;
  for (const [row, values] of scores.entries()) {
    for (let column = row + 1; column < values.length; column += 1) {
      const score = values[column];
      if (score !== null && (!best || score > best.score))
        best = { row, column, score };
    }
  }
  return best;
}

export function VectorComparison({
  items,
  onDismiss,
  onRemove,
  onClear,
}: {
  items: ComparedChunk[];
  onDismiss: () => void;
  onRemove: (chunkId: string) => void;
  onClear: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    items: ComparedChunk[];
    retry: number;
    result: Result;
  }>();
  const enough = items.length >= 2;
  const result =
    snapshot?.items === items && snapshot.retry === retry
      ? snapshot.result
      : undefined;

  useLayoutEffect(() => {
    const dialog = panel.current;
    if (!dialog) return;

    const narrow = window.matchMedia('(max-width: 900px)');
    const fitViewport = () => {
      dialog.close();
      if (narrow.matches) dialog.showModal();
      else dialog.show();
      title.current?.focus({ preventScroll: true });
    };

    fitViewport();
    narrow.addEventListener('change', fitViewport);
    return () => {
      narrow.removeEventListener('change', fitViewport);
      dialog.close();
    };
  }, []);

  useEffect(() => {
    if (items.length < 2) return;
    const controller = new AbortController();

    async function load() {
      try {
        const vectors = await Promise.all(
          items.map(async ({ file, chunkId, index }) => {
            try {
              return await request<ChunkVector>(
                chunkVectorPath(file.id, chunkId),
                { signal: controller.signal },
              );
            } catch (error) {
              throw new Error(
                `${file.originalName} · 切片 ${index + 1}：${errorMessage(error)}`,
              );
            }
          }),
        );
        if (controller.signal.aborted) return;
        const scores = vectors.map((left) =>
          vectors.map((right) => cosine(left, right)),
        );
        setSnapshot({ items, retry, result: { scores } });
      } catch (error) {
        if (controller.signal.aborted) return;
        setSnapshot({ items, retry, result: { error: errorMessage(error) } });
        controller.abort();
      }
    }

    void load();
    return () => controller.abort();
  }, [items, retry]);

  const scores = result && 'scores' in result ? result.scores : undefined;
  const best = scores ? highestPair(scores) : undefined;
  return (
    <dialog
      ref={panel}
      className="wp-panel vector-comparison"
      id="wp-comparison-panel"
      aria-labelledby="wp-comparison-title"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.currentTarget.matches(':modal')) {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className="wp-panel-head">
        <h2 id="wp-comparison-title" ref={title} tabIndex={-1}>
          <Grid2X2 aria-hidden="true" />
          向量对比
        </h2>
        <button type="button" className="wp-compare-return" onClick={onDismiss}>
          <ChevronLeft aria-hidden="true" />
          <span className="wp-compare-return-wide">返回切片核对</span>
          <span className="wp-compare-return-narrow">返回检索结果</span>
        </button>
      </div>
      <div className="vector-comparison-body">
        {!enough && (
          <p>
            从检索结果里选 2–{MAX_VECTOR_COMPARISON}{' '}
            个切片，查看两两的余弦相似度。
          </p>
        )}
        {enough && !result && <p role="status">正在读取切片向量…</p>}
        {result && 'error' in result && (
          <Notice onRetry={() => setRetry((value) => value + 1)}>
            {result.error}
          </Notice>
        )}
        {scores && (
          <div className="vector-comparison-plot">
            <table className="vector-comparison-matrix">
              <caption>
                {DEMO_MODE ? '演示向量余弦相似度' : '切片间余弦相似度'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">切片</th>
                  {items.map(({ chunkId }, index) => (
                    <th key={chunkId} scope="col">
                      {index + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scores.map((row, index) => (
                  <tr key={items[index].chunkId}>
                    <th scope="row">{index + 1}</th>
                    {row.map((score, column) => {
                      const diagonal = index === column;
                      const isBest = !diagonal && score === best?.score;
                      const color =
                        score !== null && score < 0 ? 'negative' : 'positive';
                      return (
                        <td key={items[column].chunkId}>
                          <span
                            className="vector-comparison-cell"
                            data-diagonal={diagonal}
                            data-best={isBest}
                            data-missing={score === null}
                            style={
                              score === null || diagonal
                                ? undefined
                                : {
                                    backgroundColor: `color-mix(in srgb, var(--comparison-${color}) ${Math.abs(score) * 100}%, var(--wp-reading-bg))`,
                                  }
                            }
                          >
                            {score === null ? '—' : score.toFixed(3)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div
              className="vector-comparison-scale"
              role="img"
              aria-label="相似度色阶从负一到正一，琥珀色为负值，蓝色为正值"
            >
              <span>−1</span>
              <span>0</span>
              <span>+1</span>
            </div>
            {best && (
              <div className="vector-comparison-best">
                <span>最高相似度</span>
                <span>
                  对比项 {best.row + 1} 与 {best.column + 1}
                </span>
                <strong className="wp-number">{best.score.toFixed(3)}</strong>
              </div>
            )}
            {scores.some((row) => row.includes(null)) && (
              <p>— 表示两个切片的向量空间不同，或向量无法计算相似度。</p>
            )}
          </div>
        )}
        {items.length > 0 && (
          <>
            <div className="vector-comparison-selection">
              <span>已选切片</span>
              <button
                type="button"
                className="text-action"
                onClick={() => {
                  title.current?.focus({ preventScroll: true });
                  onClear();
                }}
              >
                清空选择
              </button>
            </div>
            <ol className="vector-comparison-items">
              {items.map(({ chunkId, file, index }, position) => (
                <li key={chunkId}>
                  <span className="wp-number vector-comparison-index">
                    {position + 1}
                  </span>
                  <span className="vector-comparison-source">
                    <span>{file.originalName}</span>
                    <small>切片 {index + 1}</small>
                  </span>
                  <button
                    type="button"
                    className="vector-comparison-remove"
                    aria-label={`移除 ${file.originalName} 切片 ${index + 1}`}
                    title="移除切片"
                    onClick={() => onRemove(chunkId)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </dialog>
  );
}
