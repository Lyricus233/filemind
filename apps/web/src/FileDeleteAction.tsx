import { Ellipsis, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { ApiError, errorMessage, request } from './api';

export function FileDeleteAction({
  fileName,
  path,
  blocked,
}: {
  fileName: string;
  path: string;
  blocked: boolean;
}) {
  const navigate = useNavigate();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const deletion = useRef<AbortController | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => deletion.current?.abort(), []);

  function confirm() {
    if (blocked) return;
    setMenuOpen(false);
    setError('');
    dialog.current?.showModal();
  }

  async function remove() {
    if (deletion.current) return;
    const controller = new AbortController();
    deletion.current = controller;
    setDeleting(true);
    setError('');
    try {
      await request(path, { method: 'DELETE', signal: controller.signal });
      if (!controller.signal.aborted)
        void navigate('/files', { replace: true });
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setError('文件正在处理，请等任务结束后再删除。');
      } else if (cause instanceof ApiError && cause.status === 503) {
        setError('文件尚未清理完成，请重试删除。');
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      deletion.current = null;
      if (!controller.signal.aborted) setDeleting(false);
    }
  }

  return (
    <>
      <div
        className="file-more"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setMenuOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            event.preventDefault();
            trigger.current?.focus();
            setMenuOpen(false);
          }
        }}
      >
        <button
          ref={trigger}
          className="button file-more-trigger"
          type="button"
          aria-label="更多操作"
          aria-expanded={menuOpen}
          aria-controls={`${id}-actions`}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Ellipsis aria-hidden="true" />
        </button>
        <div
          className="file-action-menu"
          id={`${id}-actions`}
          hidden={!menuOpen}
        >
          <button
            type="button"
            aria-disabled={blocked}
            aria-describedby={blocked ? `${id}-blocked` : undefined}
            onClick={confirm}
          >
            <Trash2 aria-hidden="true" />
            删除文件
          </button>
          {blocked && <p id={`${id}-blocked`}>任务结束后可删除。</p>}
        </div>
      </div>
      <dialog
        ref={dialog}
        className="file-delete-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-filename ${id}-description`}
        onCancel={(event) => {
          if (deleting) event.preventDefault();
        }}
        onClose={() => trigger.current?.focus()}
      >
        <h2 id={`${id}-title`}>删除文件？</h2>
        <p id={`${id}-filename`} className="delete-filename" dir="auto">
          {fileName}
        </p>
        <p id={`${id}-description`} className="delete-description">
          原件、文本切片和检索索引将一并移除，删除后无法恢复。
        </p>
        {error && (
          <p className="delete-error" role="alert">
            {error}
          </p>
        )}
        <div className="delete-actions">
          <button
            className="button secondary"
            type="button"
            disabled={deleting}
            onClick={() => dialog.current?.close()}
            autoFocus
          >
            取消
          </button>
          <button
            className="button delete-confirm"
            type="button"
            disabled={deleting}
            onClick={() => void remove()}
          >
            {deleting ? '正在删除…' : '删除文件'}
          </button>
        </div>
      </dialog>
    </>
  );
}
