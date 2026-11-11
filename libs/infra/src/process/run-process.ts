import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Abort = kill the whole process group (cancel). */
  signal?: AbortSignal;
  /** Kill the process group after this many ms. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  onStdoutLine?: (line: string) => void;
  onSpawn?: (pid: number) => void;
};

export type ProcessResult = { code: number; stderrTail: string; durationMs: number };

/**
 * Runs a program with an argument array (never a shell string — media-pipeline rule 2). The child gets its own
 * process group so cancel/timeout kills it and anything it spawned. Rejects with ProcessError on non-zero
 * exit, abort or timeout.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  opts: RunProcessOptions = {},
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error('aborted'));
      return;
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group → kill(-pid) reaches grandchildren too
    });
    let stderr = '';
    let reason: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const killTree = (why: Error) => {
      if (reason || child.exitCode !== null || !child.pid) return;
      reason = why;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, opts.killGraceMs ?? 2000);
    };
    const onAbort = () =>
      killTree(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('aborted'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(
          () => killTree(new Error(`${command} timed out after ${opts.timeoutMs} ms`)),
          opts.timeoutMs,
        )
      : undefined;
    if (child.pid) opts.onSpawn?.(child.pid);
    if (opts.onStdoutLine && child.stdout) {
      createInterface({ input: child.stdout }).on('line', opts.onStdoutLine);
    } else child.stdout?.resume();
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (reason) reject(reason);
      else if (code === 0) resolve({ code, stderrTail: stderr, durationMs: Date.now() - started });
      else reject(new ProcessError(`${command} exited with ${code ?? sig}`, code, sig, stderr));
    });
  });
}

/** Creates a private temp directory, runs `fn`, and always removes the directory afterwards. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `myvideo-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Parses ffmpeg `-progress pipe:1` lines; calls back with processed seconds. */
export function ffmpegProgressParser(onSeconds: (seconds: number) => void): (line: string) => void {
  return (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
    if (m?.[1]) onSeconds(Number(m[1]) / 1_000_000);
  };
}
