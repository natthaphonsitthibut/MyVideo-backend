"""Builds s01-clip.project.json from REAL data: S01's probe + its transcript words (dev DB export).

Input: JSON {source: {id, probe}, segments: [{startMs, endMs, text, words: [{text, startMs, endMs, kind}]}]}
exported with psql from the dev database (see README.md). Output: a 9:16 Project v1 for the excerpt.
usage: python3 make-s01-clip.py <export.json> <out.json>
"""

import json
import sys
import uuid

src_path, out_path = sys.argv[1], sys.argv[2]
d = json.load(open(src_path))
probe = d["source"]["probe"]["video"]
fps_num, fps_den = probe["fps"]["num"], probe["fps"]["den"]


def fr(ms: int) -> int:
    return round(ms * fps_num / (1000 * fps_den))


def uid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"myvideo-fixture/s01/{name}"))


segs = d["segments"]
clip_start, clip_end = fr(segs[0]["startMs"]), fr(segs[-1]["endMs"])
duration = clip_end - clip_start
asset, t_video, t_cap = uid("asset"), uid("track-video"), uid("track-caption")
video = uid("video")
elements = {
    video: {
        "type": "video",
        "id": video,
        "trackId": t_video,
        "startFrame": 0,
        "durationFrames": duration,
        "origin": "ai",
        "assetId": asset,
        "sourceInFrame": clip_start,
        "playbackRate": 1,
        "volume": 1,
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0},
        "fit": "cover",
    }
}
cap_ids = []
for i, s in enumerate(segs):
    start, end = fr(s["startMs"]) - clip_start, fr(s["endMs"]) - clip_start
    if end <= start:
        continue
    words, prev_end = [], 0
    for w in s["words"]:
        ws = max(fr(w["startMs"]) - clip_start - start, prev_end)
        we = min(max(fr(w["endMs"]) - clip_start - start, ws + 1), end - start)
        if we <= ws:
            continue
        words.append({"text": w["text"], "startFrame": ws, "endFrame": we})
        prev_end = we
    if not words:
        continue
    # simple fixture layout: 3 words per line (real line layout is built in E05-F05)
    lines = [list(range(j, min(j + 3, len(words)))) for j in range(0, len(words), 3)]
    cid = uid(f"caption-{i}")
    cap_ids.append(cid)
    elements[cid] = {
        "type": "caption",
        "id": cid,
        "trackId": t_cap,
        "startFrame": start,
        "durationFrames": end - start,
        "origin": "ai",
        "words": words,
        "lines": lines,
        "styleRef": "bold-highlight",
        "transform": {"x": 0, "y": 600, "scale": 1, "rotation": 0},
    }

project = {
    "schemaVersion": 1,
    "id": uid("project"),
    "merchantId": uid("merchant"),
    "fps": {"num": fps_num, "den": fps_den},
    "width": 1080,
    "height": 1920,
    "durationFrames": duration,
    "assets": {
        asset: {
            "sourceId": d["source"]["id"],
            "kind": "video",
            "durationFrames": probe["durationFrames"],
            "hasAudio": d["source"]["probe"].get("audio") is not None,
            "width": probe["width"],
            "height": probe["height"],
        }
    },
    "tracks": [
        {"id": t_video, "kind": "video", "elementIds": [video]},
        {"id": t_cap, "kind": "caption", "elementIds": cap_ids},
    ],
    "elements": elements,
    "meta": {"createdBy": "ai", "title": "S01 12:00–12:25 (fixture)"},
}
json.dump(project, open(out_path, "w"), ensure_ascii=False, indent=1)
print(f"{len(cap_ids)} captions, {duration} frames -> {out_path}")
