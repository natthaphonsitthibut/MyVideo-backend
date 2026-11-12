import type { RenderedProbe } from '@myvideo/domain';
import { runProcess } from '../process/run-process.js';

type Stream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  start_time?: string;
  duration?: string;
  nb_read_packets?: string;
};

/** Maps ffprobe JSON (`-count_packets`) to the shape `checkRenderOutput` reads. */
export function toRenderedProbe(json: { streams?: Stream[] }): RenderedProbe {
  const streams = json.streams ?? [];
  const n = (x: string | undefined) => Number(x ?? Number.NaN);
  return {
    video: streams
      .filter((s) => s.codec_type === 'video')
      .map((s) => ({
        codec: s.codec_name ?? '',
        width: s.width ?? 0,
        height: s.height ?? 0,
        frames: n(s.nb_read_packets), // H.264 in MP4: one packet per frame
        startSec: n(s.start_time),
        durationSec: n(s.duration),
      })),
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        codec: s.codec_name ?? '',
        sampleRate: n(s.sample_rate),
        startSec: n(s.start_time),
        durationSec: n(s.duration),
      })),
  };
}

export async function probeRendered(path: string, signal?: AbortSignal): Promise<RenderedProbe> {
  const chunks: Buffer[] = [];
  await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,sample_rate,start_time,duration,nb_read_packets',
      '-of',
      'json',
      path,
    ],
    { signal, onStdoutData: (c) => chunks.push(c) },
  );
  return toRenderedProbe(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
