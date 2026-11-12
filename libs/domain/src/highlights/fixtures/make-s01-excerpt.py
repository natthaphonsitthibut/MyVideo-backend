"""Cuts a REAL excerpt of S01's stored ASR transcript (recipe 2) + its waveform peaks for highlight-scorer tests.

usage: python3 make-s01-excerpt.py <transcript-v2.json> <peaks-v1.json> <startS> <endS> <out.json>
Output: {source, startMs, endMs, segments: [{startMs, endMs, text, words}], loudness: {bucketsPerSecond, dbfs}}
`dbfs` = per 100 ms bucket, 20*log10(max |sample| / 127) from peaks level 0 (100 buckets/s), rounded to 0.1 dB;
-90 for digital silence. Times stay on the source timeline (ms).
"""

import json
import math
import sys

t_path, p_path, start_s, end_s, out_path = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
t = json.load(open(t_path))
p = json.load(open(p_path))
lo, hi = int(start_s * 1000), int(end_s * 1000)

segs = [
    {"startMs": s["startMs"], "endMs": s["endMs"], "text": s["text"], "words": s["words"]}
    for s in t["segments"]
    if s["startMs"] >= lo and s["endMs"] <= hi
]

level = p["levels"][0]
assert level["bucketsPerSecond"] == 100
mins, maxs = level["min"], level["max"]
dbfs = []
# 10 level-0 buckets per 100 ms output bucket
for b in range(lo // 100, hi // 100):
    peak = 0
    for i in range(b * 10, b * 10 + 10):
        if i < len(maxs):
            peak = max(peak, abs(mins[i]), abs(maxs[i]))
    dbfs.append(-90.0 if peak == 0 else round(20 * math.log10(peak / 127), 1))

out = {
    "source": "S01 (footage/MANIFEST.md) ZXgMkBc01mI, CC BY 3.0, seller channel 'สุรป่าน Channel'",
    "transcriptModel": t["model"],
    "transcriptRecipe": t["recipe"],
    "startMs": lo,
    "endMs": hi,
    "segments": segs,
    "loudness": {"bucketsPerSecond": 10, "startMs": lo, "dbfs": dbfs},
}
json.dump(out, open(out_path, "w"), ensure_ascii=False, indent=None, separators=(",", ":"))
print(f"{len(segs)} segments, {len(dbfs)} loudness buckets -> {out_path}")
