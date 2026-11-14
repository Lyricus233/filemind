import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { ProcessingService } from './processing.service.js';

type Page = Awaited<ReturnType<ProcessingService['findRebuildCandidates']>>;
type Target = Page['target'];
type Pending = { fileIds: string[]; nextCursor: string | null };
type Checkpoint = {
  version: 1;
  api: string;
  target: Target;
  cursor: string | null;
  pending: Pending | null;
  accepted: number;
  jobs?: SubmittedJob[];
  skipped: number;
  done: boolean;
};
type SubmittedJob = { fileId: string; jobId: string };
type Submission =
  | (SubmittedJob & { status: 'accepted'; statusUrl: string })
  | { fileId: string; status: 'failed'; statusCode: number; message: string };

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function isSubmittedJob(value: unknown): value is SubmittedJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fileId' in value &&
    'jobId' in value &&
    isUuid(value.fileId) &&
    isUuid(value.jobId)
  );
}

function validTarget(target: Target | undefined): target is Target {
  return (
    typeof target?.collection === 'string' &&
    target.collection.length > 0 &&
    typeof target.model === 'string' &&
    target.model.length > 0 &&
    Number.isInteger(target.dimensions) &&
    target.dimensions > 0
  );
}

function sameTarget(left: Target, right: Target) {
  return (
    left.collection === right.collection &&
    left.model === right.model &&
    left.dimensions === right.dimensions
  );
}

function parseApiBase(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'API must be an HTTP(S) base URL without credentials, query or fragment',
    );
  }
  return url.href.replace(/\/+$/u, '');
}

async function readCheckpoint(path: string): Promise<Checkpoint | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const state = JSON.parse(contents) as Checkpoint;
  if (
    state?.version !== 1 ||
    typeof state.api !== 'string' ||
    !validTarget(state.target) ||
    !(state.cursor === null || isUuid(state.cursor)) ||
    !Number.isSafeInteger(state.accepted) ||
    state.accepted < 0 ||
    (state.jobs !== undefined &&
      (!Array.isArray(state.jobs) ||
        state.jobs.length > state.accepted ||
        !state.jobs.every(isSubmittedJob))) ||
    !Number.isSafeInteger(state.skipped) ||
    state.skipped < 0 ||
    typeof state.done !== 'boolean' ||
    (state.pending !== null &&
      (!Array.isArray(state.pending?.fileIds) ||
        state.pending.fileIds.length < 1 ||
        state.pending.fileIds.length > 20 ||
        !state.pending.fileIds.every(isUuid) ||
        !(
          state.pending.nextCursor === null || isUuid(state.pending.nextCursor)
        ) ||
        state.done))
  ) {
    throw new Error('Invalid rebuild checkpoint');
  }
  return state;
}

async function saveCheckpoint(path: string, state: Checkpoint) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {
      flag: 'wx',
      flush: true,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function rebuildOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      api: { type: 'string' },
      apply: { type: 'boolean' },
      checkpoint: { type: 'string' },
      'max-batches': { type: 'string', default: '5' },
      'retry-uncertain': { type: 'boolean' },
      status: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.apply && !values.checkpoint) {
    throw new Error('--apply requires --checkpoint <path>');
  }
  if (values.status && (values.apply || !values.checkpoint)) {
    throw new Error(
      '--status requires --checkpoint <path> and cannot be combined with --apply',
    );
  }
  if (values['retry-uncertain'] && !values.apply) {
    throw new Error('--retry-uncertain requires --apply');
  }
  const maxBatches = Number(values['max-batches']);
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error('--max-batches must be a positive integer');
  }
  return {
    api: parseApiBase(values.api ?? 'http://127.0.0.1:3000'),
    explicitApi: values.api !== undefined,
    checkpoint: values.checkpoint ? resolve(values.checkpoint) : undefined,
    apply: values.apply,
    maxBatches,
    retryUncertain: values['retry-uncertain'],
    status: values.status,
    help: values.help,
  };
}

async function reportStatus(
  checkpoint: Checkpoint,
  request: <T>(path: string) => Promise<T>,
  emit: (data: unknown) => void,
) {
  const jobs = checkpoint.jobs ?? [];
  const counts = { completed: 0, failed: 0, pending: 0, unavailable: 0 };
  const untracked = checkpoint.accepted - jobs.length;
  const unconfirmedSubmissions = checkpoint.pending?.fileIds.length ?? 0;
  for (const { fileId, jobId } of jobs) {
    const path = `/files/${fileId}/processing-jobs/${jobId}`;
    let item: Awaited<ReturnType<typeof readStatus>>;
    try {
      item = await readStatus(path);
    } catch (error) {
      counts.unavailable += 1;
      emit({
        fileId,
        jobId,
        state: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (item.state === 'completed') counts.completed += 1;
    else if (item.state === 'failed') counts.failed += 1;
    else counts.pending += 1;
    emit({ fileId, jobId, ...item });
  }
  emit({
    target: checkpoint.target,
    submissionDone: checkpoint.done,
    accepted: checkpoint.accepted,
    skipped: checkpoint.skipped,
    unconfirmedSubmissions,
    untracked,
    ...counts,
  });
  return counts.failed ||
    counts.unavailable ||
    untracked ||
    unconfirmedSubmissions
    ? 1
    : 0;

  async function readStatus(path: string) {
    const item = await request<{
      state?: unknown;
      phase?: unknown;
      stale?: unknown;
      progressUpdatedAt?: unknown;
      error?: unknown;
    }>(path);
    if (typeof item?.state !== 'string' || !item.state) {
      throw new Error('API returned an invalid job status');
    }
    return {
      state: item.state,
      phase: typeof item.phase === 'string' ? item.phase : null,
      stale: item.stale === true,
      progressUpdatedAt:
        typeof item.progressUpdatedAt === 'string'
          ? item.progressUpdatedAt
          : null,
      error: typeof item.error === 'string' ? item.error : null,
    };
  }
}

export async function runRebuild(
  options: ReturnType<typeof rebuildOptions>,
  {
    fetcher = fetch,
    report = console.log,
  }: {
    fetcher?: typeof fetch;
    report?: (value: string) => void;
  } = {},
) {
  let { api } = options;
  const { checkpoint } = options;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(api + path, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`${path} returned HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async function candidates(cursor: string | null) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page = await request<Page>(`/files/index/rebuild-candidates${query}`);
    const ids = page?.items?.map(({ id }) => id);
    if (
      !validTarget(page?.target) ||
      !ids ||
      ids.length > 20 ||
      ids.some(
        (id, index) => !isUuid(id) || id <= (ids[index - 1] ?? cursor ?? ''),
      ) ||
      (page.nextCursor !== null && page.nextCursor !== ids.at(-1))
    ) {
      throw new Error('API returned an invalid rebuild candidate page');
    }
    return page;
  }

  function emit(data: unknown) {
    report(JSON.stringify(data));
  }

  if (options.status && checkpoint) {
    const saved = await readCheckpoint(checkpoint);
    if (!saved) throw new Error('Rebuild checkpoint was not found');
    if (options.explicitApi && saved.api !== api) {
      throw new Error('Checkpoint belongs to a different API');
    }
    api = parseApiBase(saved.api);
    return reportStatus(saved, request, emit);
  }

  if (!options.apply || !checkpoint) {
    emit(await candidates(null));
    return 0;
  }

  const lockPath = `${checkpoint}.lock`;
  const lock = await open(lockPath, 'wx').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST')
        throw new Error(`Checkpoint is locked: ${lockPath}`);
      throw error;
    },
  );

  try {
    const prior = await readCheckpoint(checkpoint);
    if (prior && prior.api !== api)
      throw new Error('Checkpoint belongs to a different API');
    if (prior?.pending && !options.retryUncertain) {
      throw new Error(
        'Previous submission is unconfirmed. Review its file IDs and use --retry-uncertain to replay that batch.',
      );
    }
    let page = await candidates(prior?.cursor ?? null);
    const state: Checkpoint = prior ?? {
      version: 1,
      api,
      target: page.target,
      cursor: null,
      pending: null,
      accepted: 0,
      skipped: 0,
      done: false,
    };
    if (!sameTarget(state.target, page.target)) {
      throw new Error('Index target changed since the checkpoint was created');
    }
    for (let batch = 0; batch < options.maxBatches && !state.done; batch += 1) {
      if (!sameTarget(state.target, page.target)) {
        throw new Error('Index target changed during the rebuild');
      }
      const pending: Pending = state.pending ?? {
        fileIds: page.items.map(({ id }) => id),
        nextCursor: page.nextCursor,
      };
      if (pending.fileIds.length === 0) {
        state.done = true;
        await saveCheckpoint(checkpoint, state);
        break;
      }
      state.pending = pending;
      await saveCheckpoint(checkpoint, state);
      const { items } = await request<{ items: Submission[] }>(
        '/files/process',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileIds: pending.fileIds }),
        },
      );
      const returned = new Set(items.map(({ fileId }) => fileId));
      if (
        items.length !== pending.fileIds.length ||
        returned.size !== items.length ||
        !pending.fileIds.every((id) => returned.has(id)) ||
        items.some((item) =>
          item.status === 'accepted'
            ? !isSubmittedJob(item) || !item.statusUrl
            : item.status !== 'failed' || !Number.isInteger(item.statusCode),
        )
      ) {
        throw new Error('API returned an incomplete batch response');
      }
      const retry: string[] = [];
      for (const item of items) {
        if (item.status === 'accepted') {
          state.accepted += 1;
          (state.jobs ??= []).push({ fileId: item.fileId, jobId: item.jobId });
        } else if (item.statusCode === 404) state.skipped += 1;
        else retry.push(item.fileId);
      }
      if (retry.length > 0) {
        state.pending = { ...pending, fileIds: retry };
      } else {
        state.pending = null;
        state.cursor = pending.nextCursor ?? state.cursor;
        state.done = pending.nextCursor === null;
      }
      await saveCheckpoint(checkpoint, state);
      emit({ items });
      if (retry.length > 0) break;
      if (!state.done && batch + 1 < options.maxBatches) {
        page = await candidates(state.cursor);
      }
    }
    emit({
      target: state.target,
      accepted: state.accepted,
      skipped: state.skipped,
      retryPending: state.pending?.fileIds.length ?? 0,
      done: state.done,
    });
    return state.pending ? 1 : 0;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const options = rebuildOptions(process.argv.slice(2));
    if (options.help) {
      console.log(
        'files:rebuild-index [--api <url>] [--apply --checkpoint <path>] [--max-batches <n>] [--retry-uncertain]\nfiles:rebuild-index --status --checkpoint <path>',
      );
    } else {
      process.exitCode = await runRebuild(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
