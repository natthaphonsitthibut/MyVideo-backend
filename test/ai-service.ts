import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AiServiceClient } from '@myvideo/infra';

const AI_DIR = fileURLToPath(new URL('../services/ai', import.meta.url));

/** Starts the real Python AI service (uv) on `port` and waits until /health answers. */
export async function startAiService(port: number): Promise<{ url: string; stop: () => void }> {
  const proc: ChildProcess = spawn('uv', ['run', '--frozen', 'python', '-m', 'myvideo_ai'], {
    cwd: AI_DIR,
    env: { ...process.env, AI_PORT: String(port), AI_LOG_LEVEL: 'warning' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const client = new AiServiceClient({ baseUrl: url });
  for (let i = 0; i < 150; i++) {
    if ((await client.probe(500)).status === 'up') return { url, stop: () => proc.kill('SIGTERM') };
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  throw new Error('AI service did not start');
}
