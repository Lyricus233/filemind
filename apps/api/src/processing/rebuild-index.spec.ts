import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rebuildOptions, runRebuild } from './rebuild-index.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const third = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const target = { collection: 'chunks_v2', model: 'test', dimensions: 3 };
const page = (ids: string[], nextCursor: string | null = null) =>
  Response.json({ target, items: ids.map((id) => ({ id })), nextCursor });
const accepted = (fileId: string) => ({
  fileId,
  status: 'accepted',
  jobId,
  statusUrl: `/files/${fileId}/processing-jobs/${jobId}`,
});

describe('file index rebuild CLI', () => {
  let directory: string;
  let checkpoint: string;
  const fetcher = vi.fn<typeof fetch>();
  const report = vi.fn<(value: string) => void>();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'filemind-rebuild-'));
    checkpoint = join(directory, 'checkpoint.json');
    fetcher.mockReset();
    report.mockReset();
  });

  afterEach(async () => {
    await rm(checkpoint, { force: true });
    await rmdir(directory);
  });

  const options = (...args: string[]) =>
    rebuildOptions(['--apply', '--checkpoint', checkpoint, ...args]);

  it('previews candidates with a single GET and writes no checkpoint', async () => {
    fetcher.mockResolvedValueOnce(page([first]));
    await expect(
      runRebuild(rebuildOptions(['--checkpoint', checkpoint]), {
        fetcher,
        report,
      }),
    ).resolves.toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
    await expect(readFile(checkpoint)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('continues from the saved cursor and refuses to submit against a changed target', async () => {
    fetcher
      .mockResolvedValueOnce(page([first], first))
      .mockResolvedValueOnce(Response.json({ items: [accepted(first)] }));
    await expect(
      runRebuild(options('--max-batches', '1'), { fetcher, report }),
    ).resolves.toBe(0);
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({
      cursor: first,
      accepted: 1,
      done: false,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({
        target: { ...target, model: 'changed' },
        items: [{ id: second }],
        nextCursor: null,
      }),
    );
    await expect(runRebuild(options(), { fetcher, report })).rejects.toThrow(
      'Index target changed',
    );
    expect(fetcher.mock.calls[2][0]).toContain(`?cursor=${first}`);
    expect(fetcher).toHaveBeenCalledTimes(3);

    fetcher
      .mockResolvedValueOnce(page([second]))
      .mockResolvedValueOnce(Response.json({ items: [accepted(second)] }));
    await expect(runRebuild(options(), { fetcher, report })).resolves.toBe(0);
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({
      accepted: 2,
      done: true,
    });
  });

  it('keeps only unresolved submissions and requires an explicit replay', async () => {
    fetcher
      .mockResolvedValueOnce(page([first, second, third], third))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            accepted(first),
            { fileId: second, status: 'failed', statusCode: 404 },
            { fileId: third, status: 'failed', statusCode: 503 },
          ],
        }),
      );
    await expect(runRebuild(options(), { fetcher, report })).resolves.toBe(1);
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({
      pending: { fileIds: [third], nextCursor: third },
      accepted: 1,
      skipped: 1,
    });

    await expect(runRebuild(options(), { fetcher, report })).rejects.toThrow(
      'unconfirmed',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(Response.json({ items: [accepted(third)] }));
    await expect(
      runRebuild(options('--retry-uncertain', '--max-batches', '1'), {
        fetcher,
        report,
      }),
    ).resolves.toBe(0);
    expect(fetcher.mock.calls[3][1]?.body).toBe(
      JSON.stringify({ fileIds: [third] }),
    );
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({
      pending: null,
      cursor: third,
      accepted: 2,
      skipped: 1,
    });
  });

  it('retains the submitted IDs when the API response is lost', async () => {
    fetcher
      .mockResolvedValueOnce(page([first]))
      .mockRejectedValueOnce(new Error('network error'));
    await expect(runRebuild(options(), { fetcher, report })).rejects.toThrow(
      'network error',
    );
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toMatchObject({
      cursor: null,
      pending: { fileIds: [first], nextCursor: null },
      done: false,
    });
  });

  it('reads saved job status from the original API without changing the checkpoint', async () => {
    const api = 'http://localhost:3100/api';
    fetcher
      .mockResolvedValueOnce(page([first, second, third]))
      .mockResolvedValueOnce(
        Response.json({
          items: [accepted(first), accepted(second), accepted(third)],
        }),
      );
    await expect(
      runRebuild(options('--api', api), { fetcher, report }),
    ).resolves.toBe(0);
    const saved = await readFile(checkpoint, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({
      jobs: [
        { fileId: first, jobId },
        { fileId: second, jobId },
        { fileId: third, jobId },
      ],
    });
    fetcher.mockReset();
    report.mockClear();
    fetcher
      .mockResolvedValueOnce(Response.json({ state: 'completed' }))
      .mockResolvedValueOnce(
        Response.json({
          state: 'active',
          phase: 'embedding',
          stale: true,
          progressUpdatedAt: '2026-11-01T08:00:00Z',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      runRebuild(rebuildOptions(['--status', '--checkpoint', checkpoint]), {
        fetcher,
        report,
      }),
    ).resolves.toBe(1);
    expect(
      fetcher.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual(
      [first, second, third].map((fileId) => [
        `${api}${accepted(fileId).statusUrl}`,
        undefined,
      ]),
    );
    expect(report.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      expect.objectContaining({ fileId: first, state: 'completed' }),
      expect.objectContaining({
        fileId: second,
        state: 'active',
        phase: 'embedding',
        stale: true,
        progressUpdatedAt: '2026-11-01T08:00:00Z',
      }),
      expect.objectContaining({ fileId: third, state: 'unavailable' }),
      expect.objectContaining({
        accepted: 3,
        completed: 1,
        failed: 0,
        pending: 1,
        unavailable: 1,
        untracked: 0,
        submissionDone: true,
      }),
    ]);
    expect(await readFile(checkpoint, 'utf8')).toBe(saved);
  });

  it('reports old submissions without job IDs and does not guess from the file state', async () => {
    await writeFile(
      checkpoint,
      JSON.stringify({
        version: 1,
        api: 'http://127.0.0.1:3000',
        target,
        cursor: null,
        pending: null,
        accepted: 1,
        skipped: 0,
        done: true,
      }),
    );
    await expect(
      runRebuild(rebuildOptions(['--status', '--checkpoint', checkpoint]), {
        fetcher,
        report,
      }),
    ).resolves.toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(report.mock.calls[0][0])).toMatchObject({
      accepted: 1,
      completed: 0,
      untracked: 1,
    });
  });
});
