import type { StoragePort } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MusicEntity } from '../db/entities/music.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { runProcess } from '../process/run-process.js';
/** Beat/onset estimates from a measured 100-Hz RMS envelope. Ambiguous periodicity has no invented BPM. */
export function musicRhythm(rms: readonly number[], hz = 100) {
  const onset = rms.map((v, i) => Math.max(0, v - (rms[i - 1] ?? v)));
  const norm = onset.reduce((n, v) => n + v * v, 0);
  let best = 0,
    lag = 0;
  for (let d = Math.round((hz * 60) / 180); d <= Math.round((hz * 60) / 60); d++) {
    let sum = 0;
    for (let i = d; i < onset.length; i++) sum += (onset[i] ?? 0) * (onset[i - d] ?? 0);
    const score = norm > 0 ? sum / norm : 0;
    if (score > best) {
      best = score;
      lag = d;
    }
  }
  const peak = onset.reduce((n, v) => Math.max(n, v), 0),
    beatsSec: number[] = [];
  for (let i = 1; i + 1 < onset.length; i++)
    if (
      (onset[i] ?? 0) > peak * 0.35 &&
      (onset[i] ?? 0) > (onset[i - 1] ?? 0) &&
      (onset[i] ?? 0) >= (onset[i + 1] ?? 0) &&
      i / hz - (beatsSec.at(-1) ?? -1) > 0.2
    )
      beatsSec.push(i / hz);
  const dropsSec: number[] = [];
  const window = hz * 2;
  for (let i = window; i + window < rms.length; i += hz) {
    const before = rms.slice(i - window, i).reduce((n, v) => n + v, 0) / window;
    const after = rms.slice(i, i + window).reduce((n, v) => n + v, 0) / window;
    if (before > 0.001 && after > before * 1.8 && i / hz - (dropsSec.at(-1) ?? -20) > 8)
      dropsSec.push(i / hz);
  }
  return {
    bpm: best >= 0.2 && lag ? Math.round(((hz * 60) / lag) * 10) / 10 : null,
    confidence: Math.round(best * 1000) / 1000,
    firstBeatSec: beatsSec[0] ?? null,
    beatsSec,
    dropsSec,
  };
}
export function musicAnalysisHandler({ ds, storage }: { ds: DataSource; storage: StoragePort }): JobHandler {
  return {
    type: 'music.analyse',
    queue: 'media',
    async run({ job, signal, progress }) {
      const repo = ds.getRepository(MusicEntity),
        row = await repo.findOneByOrFail({ id: String(job.payload.musicId), merchantId: job.merchantId });
      if (row.status === 'ready') return { musicId: row.id, reused: true };
      const f = await storage.localPath(row.storageKey);
      try {
        let json = '';
        await runProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f.path], {
          signal,
          timeoutMs: 30000,
          onStdoutLine: (l) => {
            json += l;
          },
        });
        const probe = JSON.parse(json) as {
          format: { duration: string };
          streams: { codec_type: string; codec_name: string }[];
        };
        const audio = probe.streams.find((s) => s.codec_type === 'audio'),
          duration = Number(probe.format.duration);
        if (!audio || !Number.isFinite(duration) || duration < 1 || duration > 1200)
          throw new FatalJobError('ไฟล์เพลงต้องมีเสียงและยาว 1 วินาทีถึง 20 นาที');
        await progress(0.15);
        const chunks: Buffer[] = [];
        await runProcess(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-i',
            f.path,
            '-map',
            '0:a:0',
            '-vn',
            '-ac',
            '1',
            '-ar',
            '400',
            '-f',
            'f32le',
            'pipe:1',
          ],
          { signal, timeoutMs: 180000, onStdoutData: (c) => chunks.push(c) },
        );
        const pcm = Buffer.concat(chunks),
          rms: number[] = [];
        for (let i = 0; i + 16 <= pcm.length; i += 16) {
          let sum = 0;
          for (let j = 0; j < 4; j++) sum += pcm.readFloatLE(i + j * 4) ** 2;
          rms.push(Math.sqrt(sum / 4));
        }
        const analysis = musicRhythm(rms);
        await repo.update(
          { id: row.id, merchantId: job.merchantId },
          {
            status: 'ready',
            durationMs: Math.round(duration * 1000),
            analysis: analysis as never,
            error: null,
            contentType:
              audio.codec_name === 'mp3'
                ? 'audio/mpeg'
                : audio.codec_name === 'flac'
                  ? 'audio/flac'
                  : audio.codec_name.startsWith('pcm')
                    ? 'audio/wav'
                    : 'audio/mp4',
          },
        );
        return { musicId: row.id, ...analysis };
      } catch (error) {
        if (signal.aborted)
          await repo.update(
            { id: row.id, merchantId: job.merchantId },
            {
              status: 'failed',
              error: 'การวิเคราะห์เพลงหยุดแล้ว ลองใหม่ได้จากบันทึกงาน',
            },
          );
        throw error;
      } finally {
        await f.release();
      }
    },
    async onDead(em, job, error) {
      await em
        .getRepository(MusicEntity)
        .update(
          { id: String(job.payload.musicId), merchantId: job.merchantId },
          { status: 'failed', error: error.message.slice(0, 1000) },
        );
    },
  };
}
