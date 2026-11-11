import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegProgressParser, ProcessError, runProcess, withTempDir } from './run-process.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runProcess', () => {
  it('resolves on exit 0 and streams stdout lines', async () => {
    const lines: string[] = [];
    const r = await runProcess('sh', ['-c', 'echo one; echo two'], { onStdoutLine: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines).toEqual(['one', 'two']);
  });

  it('passes arguments without a shell (no injection)', async () => {
    const lines: string[] = [];
    await runProcess('echo', ['$(whoami); rm -rf /'], { onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(['$(whoami); rm -rf /']);
  });

  it('rejects with a ProcessError carrying the stderr tail', async () => {
    const err = await runProcess('sh', ['-c', 'echo bad >&2; exit 3']).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessError);
    expect(err.code).toBe(3);
    expect(err.stderrTail).toContain('bad');
  });

  it('kills the whole process tree on abort', async () => {
    const ac = new AbortController();
    let pid = 0;
    // parent shell spawns a grandchild sleep; both must die
    const p = runProcess('sh', ['-c', 'sleep 30 & echo $!; wait'], {
      signal: ac.signal,
      onSpawn: (x) => {
        pid = x;
      },
      onStdoutLine: () => ac.abort(new Error('cancelled by test')),
    });
    await expect(p).rejects.toThrow('cancelled by test');
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    const grand = await runProcess('pgrep', ['-g', String(pid)]).catch((e: ProcessError) => e);
    expect(grand).toBeInstanceOf(ProcessError); // pgrep exit 1 = no process in that group
  });

  it('times out', async () => {
    await expect(runProcess('sleep', ['10'], { timeoutMs: 150 })).rejects.toThrow(/timed out after 150 ms/);
  });
});

describe('withTempDir', () => {
  it('removes the directory on success and on error', async () => {
    let kept = '';
    await withTempDir('t', async (dir) => {
      kept = dir;
      await writeFile(join(dir, 'x.bin'), 'x');
    });
    expect(existsSync(kept)).toBe(false);
    await expect(
      withTempDir('t', async (dir) => {
        kept = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(kept)).toBe(false);
  });
});

describe('ffmpegProgressParser', () => {
  it('reads out_time_us', () => {
    const got: number[] = [];
    const parse = ffmpegProgressParser((s) => got.push(s));
    for (const l of ['frame=10', 'out_time_us=1500000', 'progress=continue', 'out_time_ms=2000000']) parse(l);
    expect(got).toEqual([1.5, 2]);
  });
});
