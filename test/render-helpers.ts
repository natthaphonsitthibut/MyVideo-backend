import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FOOTAGE_DIR } from './footage.js';

const exec = promisify(execFile);

/** Real long recording S01 (footage/MANIFEST.md) — undefined on machines without the footage folder. */
export const S01_PATH = (() => {
  const p = `${FOOTAGE_DIR}/long/ZXgMkBc01mI-10m-55m.mp4`;
  return existsSync(p) ? p : undefined;
})();

/**
 * The committed S01 clip project (real transcript captions, libs/contracts fixtures) cut to its first `frames`
 * frames: elements past the end are dropped, the video element is shortened.
 */
export function s01Project(frames: number): any {
  const p = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../libs/contracts/src/project/fixtures/s01-clip.project.json', import.meta.url)),
      'utf8',
    ),
  );
  p.durationFrames = frames;
  for (const [id, e] of Object.entries<any>(p.elements)) {
    if (e.startFrame >= frames || (e.type === 'caption' && e.startFrame + e.durationFrames > frames)) {
      delete p.elements[id];
      for (const t of p.tracks) t.elementIds = t.elementIds.filter((x: string) => x !== id);
    } else if (e.startFrame + e.durationFrames > frames) e.durationFrames = frames - e.startFrame;
  }
  return p;
}

export type ProbedOutput = {
  video: { codec: string; width: number; height: number; fps: string; frames: number; durationSec: number };
  audio: { codec: string; sampleRate: number; channels: number; durationSec: number } | null;
};

/** ffprobe with a decoded frame count (`-count_frames`). */
export async function probeOutput(path: string): Promise<ProbedOutput> {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration,sample_rate,channels',
    '-of',
    'json',
    path,
  ]);
  const streams: any[] = JSON.parse(stdout).streams;
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    video: {
      codec: v.codec_name,
      width: v.width,
      height: v.height,
      fps: v.r_frame_rate,
      frames: Number(v.nb_read_frames),
      durationSec: Number(v.duration),
    },
    audio: a
      ? {
          codec: a.codec_name,
          sampleRate: Number(a.sample_rate),
          channels: a.channels,
          durationSec: Number(a.duration),
        }
      : null,
  };
}

/** Samples the RSS of `rootPid` and all its descendants every `everyMs`; `stop()` returns the peak in MB. */
export function sampleTreeRss(rootPid: number, everyMs = 250): { stop(): Promise<number> } {
  let peak = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
      const rows = stdout
        .trim()
        .split('\n')
        .map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
      const kids = new Map<number, number[]>();
      for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
      const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
      let total = 0;
      const stack = [rootPid];
      while (stack.length) {
        const p = stack.pop() as number;
        total += rss.get(p) ?? 0;
        stack.push(...(kids.get(p) ?? []));
      }
      peak = Math.max(peak, total / 1024);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  return {
    async stop() {
      clearInterval(timer);
      await tick();
      return Math.round(peak);
    },
  };
}

/** Mono 16 kHz float PCM of [startSec, startSec+durSec) of a file (ffmpeg accurate seek). */
export async function pcm(path: string, startSec: number, durSec: number): Promise<Float32Array> {
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(startSec),
      '-t',
      String(durSec),
      '-i',
      path,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const b = stdout as unknown as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/**
 * Lag (ms) of `needle` inside `hay`, where `hay` starts `padMs` before `needle` would if aligned: normalised
 * cross-correlation over every lag in ±padMs. 0 = perfectly aligned; positive = output late.
 */
export function xcorrLagMs(needle: Float32Array, hay: Float32Array, padMs: number, rate = 16000): number {
  const pad = Math.round((padMs * rate) / 1000);
  let best = -Infinity;
  let bestLag = 0;
  const nn = Math.sqrt(needle.reduce((s, x) => s + x * x, 0)) || 1;
  for (let lag = -pad; lag <= pad; lag++) {
    let dot = 0;
    let hh = 0;
    for (let i = 0; i < needle.length; i++) {
      const h = hay[i + pad + lag] ?? 0;
      dot += (needle[i] as number) * h;
      hh += h * h;
    }
    const score = dot / (nn * (Math.sqrt(hh) || 1));
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return (-bestLag * 1000) / rate;
}

/** Grey 135×240 pixels of frames of a file after `vf` (one Uint8Array per frame). */
export async function greyFrames(
  path: string,
  opts: { startSec: number; frames: number; vf?: string },
): Promise<Uint8Array[]> {
  const vf = [opts.vf, 'scale=135:240', 'format=gray'].filter(Boolean).join(',');
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(opts.startSec),
      '-i',
      path,
      '-frames:v',
      String(opts.frames),
      '-vf',
      vf,
      '-f',
      'rawvideo',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const b = stdout as unknown as Buffer;
  const size = 135 * 240;
  return Array.from({ length: Math.floor(b.byteLength / size) }, (_, i) =>
    b.subarray(i * size, (i + 1) * size),
  );
}

export const mse = (a: Uint8Array, b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += ((a[i] as number) - (b[i] as number)) ** 2;
  return s / a.length;
};

/** Integrated loudness (LUFS) and true peak of a file, measured by ffmpeg's loudnorm. */
export async function loudness(path: string): Promise<{ i: number; tp: number }> {
  const { stderr } = await exec('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-i',
    path,
    '-vn',
    '-af',
    'loudnorm=print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const j = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
  return { i: Number(j.input_i), tp: Number(j.input_tp) };
}

/** Per-frame MD5 of the decoded video ('v') or audio ('a') stream (`ffmpeg -f framemd5`). */
export async function frameMd5(path: string, stream: 'v' | 'a'): Promise<string[]> {
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-map', `0:${stream}`, '-f', 'framemd5', '-'],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop()?.trim() ?? '');
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
