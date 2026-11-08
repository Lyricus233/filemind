import { useEffect, useState } from 'react';

import { errorMessage, request } from './api';
import type { ProcessingJob } from './api';

type Result<T> = { data: T; error?: never } | { data?: never; error: string };

export function isFinished(
  job: Pick<ProcessingJob, 'state'> | null | undefined,
) {
  return job?.state === 'completed' || job?.state === 'failed';
}

export function useResource<T>(
  path: string | null,
  refresh = 0,
  shouldPoll?: (result: T) => boolean,
) {
  const key = `${refresh}:${path ?? ''}`;
  const [snapshot, setSnapshot] = useState<{ key: string; value: Result<T> }>();

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read(url: string) {
      try {
        const data = await request<T>(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSnapshot({ key, value: { data } });
        if (shouldPoll?.(data)) {
          timer = setTimeout(() => void read(url), 1500);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSnapshot({ key, value: { error: errorMessage(error) } });
        }
      }
    }

    void read(path);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, key, shouldPoll]);

  const result = snapshot?.key === key ? snapshot.value : undefined;
  return {
    data: result?.data,
    error: result?.error,
    loading: Boolean(path && !result),
  };
}
