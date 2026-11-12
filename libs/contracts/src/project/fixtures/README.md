# Project JSON fixtures

`s01-clip.project.json` — a 9:16 clip (710 frames @ 30 fps) of footage S01 (`footage/MANIFEST.md`; the media
itself is never in this repo), 12:00–12:25 of the source, with 13 caption elements whose words and timings are
the **real** ASR transcript (whisper.cpp large-v3-turbo, 2026-11-12) of that excerpt. Ids are deterministic
(uuid5). Caption line breaks are a simple 3-words-per-line layout; real line layout comes with the caption
builder.

Re-create (dev database with S01 ingested and transcribed):

```sh
psql -h localhost -d myvideo_dev -Atc "select json_build_object('source', (select json_build_object('id', id, 'probe', probe) from video_sources where id='<S01 source id>'), 'segments', (select json_agg(json_build_object('startMs', start_ms, 'endMs', end_ms, 'text', text, 'words', words) order by seq) from transcript_segments where transcript_id='<transcript id>' and start_ms >= 720000 and end_ms <= 745000))" -o export.json
python3 make-s01-clip.py export.json s01-clip.project.json
```
