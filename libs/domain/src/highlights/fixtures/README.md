# Highlight scorer fixtures

`s01-0400-0800.json` — minutes 04:00–08:00 of footage S01 (`footage/MANIFEST.md`; the media itself is never in
this repo): the **real** stored ASR transcript (whisper.cpp large-v3-turbo, transcript recipe 2, 2026-11-12) —
92 segments with word timings on the source timeline — and loudness per 100 ms derived from the source's real
waveform peaks (`peaks-v1.json`, same formula as `loudnessFromPeaks` in `libs/infra/src/media/peaks.ts`).

`vad.speech` — the **real** Silero VAD (whisper.cpp `ggml-silero-v6.2.0.bin`, min silence 300 ms) speech segments
of the same 4 minutes, from our AI service `POST /vad` on the excerpt's 16 kHz audio (51 segments, 208.7 s of
speech), shifted to the source timeline. Added 2026-11-12 for clip boundary snapping (E07-F04).

Source: "ไลฟ์สดขายเสื้อมัดย้อม EP.8", สุรป่าน Channel, https://www.youtube.com/watch?v=ZXgMkBc01mI —
licensed CC BY 3.0 (attribution: สุรป่าน Channel). The excerpt contains ASR errors on purpose: the scorer has
to work on what the recogniser really produces.

Re-create (dev storage with S01 ingested and transcribed):

```sh
python3 make-s01-excerpt.py <…/transcript-v2.json> <…/peaks-v1.json> 240 480 s01-0400-0800.json
```
