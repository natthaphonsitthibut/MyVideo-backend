"""ASR evaluation harness (E04-F06): CER on the Thai reference set + timing sanity on exactly-labelled audio.

    uv run --frozen python -m myvideo_ai.eval_asr --out ../../../docs/eval/asr-<date>.md

Runs the real `WhisperServer` code path once per configuration (built-in VAD on / off, D-017) — one model
process at a time (8 GB machine). Numbers in the report come only from this run.
"""

import argparse
import dataclasses
import json
import platform
import statistics
import struct
import time
import unicodedata
from datetime import date
from pathlib import Path

from .asr import WhisperServer, decode_flags
from .settings import Settings

WORKSPACE = Path(__file__).resolve().parents[5]
FLEURS = WORKSPACE / "footage" / "speech-th" / "fleurs-th-dev"
TIMING = WORKSPACE / "footage" / "labels" / "vad" / "fleurs-concat"
THANTHAKHAT = "์"
# E01-F03 numbers for the same model and set (spikes/e01-asr/RESULTS.md, jiwer corpus CER)
E01 = {True: 0.157, False: 0.132}


def norm(text: str) -> str:
    """Same normalisation as E01 (bench.py): NFC, lower-case, drop whitespace, punctuation and symbols."""
    t = unicodedata.normalize("NFC", text).lower()
    return "".join(ch for ch in t if not ch.isspace() and not unicodedata.category(ch).startswith(("P", "S")))


def edit_distance(a: str, b: str) -> int:
    """Levenshtein distance over characters (code points)."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def corpus_cer(refs: list[str], hyps: list[str]) -> float:
    """Sum of edits / sum of reference characters, after `norm` (as jiwer's corpus CER)."""
    edits = sum(edit_distance(norm(r), norm(h)) for r, h in zip(refs, hyps, strict=True))
    chars = sum(len(norm(r)) for r in refs)
    return edits / chars if chars else 0.0


def timing_sanity(segments: list[tuple[int, int]], spans: list[tuple[int, int]]) -> dict:
    """Recognised segments vs exact speech spans: midpoints in speech, pause crossings, start error."""
    inside = sum(1 for s, e in segments if any(a <= (s + e) / 2 <= b for a, b in spans))
    crossing = sum(1 for s, e in segments if sum(1 for a, b in spans if s < b and e > a) > 1)
    starts = [s for s, _ in segments]
    errors = [min(abs(s - a) for s in starts) for a, _ in spans] if starts else []
    return {
        "segments": len(segments),
        "midpoints_in_speech": inside / len(segments) if segments else 0.0,
        "crossing_pauses": crossing,
        "median_start_error_ms": round(statistics.median(errors)) if errors else None,
        "max_start_error_ms": max(errors) if errors else None,
    }


def wav_ms(path: Path) -> int:
    """Duration of a RIFF/WAVE file from its header (works for PCM and IEEE-float, unlike `wave`)."""
    with path.open("rb") as f:
        if f.read(4) != b"RIFF" or (f.read(4) and f.read(4) != b"WAVE"):
            raise ValueError(f"not a WAV file: {path}")
        byte_rate = 0
        while chunk := f.read(8):
            cid, size = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if cid == b"fmt ":
                fmt = f.read(size)
                byte_rate = struct.unpack("<I", fmt[8:12])[0]
            elif cid == b"data":
                if not byte_rate:
                    raise ValueError(f"WAV data before fmt: {path}")
                return round(size * 1000 / byte_rate)
            else:
                f.seek(size + (size & 1), 1)
    raise ValueError(f"WAV without data chunk: {path}")


def run_config(builtin_vad: bool) -> dict:
    settings = dataclasses.replace(Settings(), asr_builtin_vad=builtin_vad)
    refs = [
        json.loads(line) for line in (FLEURS / "references.jsonl").read_text().splitlines() if line.strip()
    ]
    labels = json.loads(TIMING.with_suffix(".labels.json").read_text())
    asr = WhisperServer(settings)
    rows, elapsed, audio = [], 0, 0
    try:
        asr.transcribe(FLEURS / refs[0]["file"])  # warm-up: model load is not part of the timing
        for r in refs:
            path = FLEURS / r["file"]
            t0 = time.monotonic()
            res = asr.transcribe(path)
            elapsed += round((time.monotonic() - t0) * 1000)
            audio += wav_ms(path)
            hyp = "".join(s.text for s in res.segments)
            rows.append({"file": r["file"], "ref": r["text"], "hyp": hyp})
        timed = asr.transcribe(TIMING.with_suffix(".wav"))
    finally:
        asr.stop()
    per = [edit_distance(norm(x["ref"]), norm(x["hyp"])) / max(1, len(norm(x["ref"]))) for x in rows]
    for x, c in zip(rows, per, strict=True):
        x["cer"] = c
    spans = [(u["speechStartMs"], u["speechEndMs"]) for u in labels["utterances"]]
    return {
        "builtin_vad": builtin_vad,
        "flags": " ".join(decode_flags(builtin_vad, settings.vad_model)),
        "model": settings.asr_model,
        "utterances": len(rows),
        "cer": corpus_cer([x["ref"] for x in rows], [x["hyp"] for x in rows]),
        "cer_mean": statistics.mean(per),
        "cer_median": statistics.median(per),
        "thanthakhat_ref": sum(x["ref"].count(THANTHAKHAT) for x in rows),
        "thanthakhat_hyp": sum(x["hyp"].count(THANTHAKHAT) for x in rows),
        "audio_ms": audio,
        "elapsed_ms": elapsed,
        "timing": timing_sanity([(s.start_ms, s.end_ms) for s in timed.segments], spans),
        "rows": rows,
    }


def report(results: list[dict]) -> str:
    machine = f"{platform.machine()} macOS {platform.mac_ver()[0]}"
    out = [
        f"# ASR evaluation — {date.today().isoformat()}",
        "",
        f"Generated by `pnpm eval:asr` (`myvideo_ai.eval_asr`) on {machine}. **Verified**: every number below"
        " was measured in this run (real `WhisperServer` code path, one model process per configuration,"
        " model load excluded from timing).",
        "",
        "- CER set: FLEURS th dev, 60 read utterances (CC BY 4.0, `footage/speech-th/fleurs-th-dev`),"
        " normalised as in E01 (NFC, lower-case, no spaces/punctuation/symbols),"
        " corpus CER = edits / reference chars.",
        "- Timing sanity: `footage/labels/vad/fleurs-concat.wav` — 12 FLEURS utterances joined with"
        " inserted pauses, speech spans exact by construction (MANIFEST L01).",
        "",
        "| Config | Flags | CER (corpus) | E01 CER | mean / median per utt. | ์ in hyp / ref | x realtime "
        "| midpoints in speech | segments crossing a pause | median / max start error |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        t = r["timing"]
        flags = r["flags"].replace(str(Path.home()), "~")
        out.append(
            f"| built-in VAD {'on' if r['builtin_vad'] else 'off'} | `{flags}` "
            f"| **{r['cer'] * 100:.1f} %** | {E01[r['builtin_vad']] * 100:.1f} % "
            f"| {r['cer_mean'] * 100:.1f} % / {r['cer_median'] * 100:.1f} % "
            f"| {r['thanthakhat_hyp']} / {r['thanthakhat_ref']} "
            f"| {r['audio_ms'] / max(1, r['elapsed_ms']):.1f} x "
            f"| {t['midpoints_in_speech'] * 100:.0f} % of {t['segments']} | {t['crossing_pauses']} "
            f"| {t['median_start_error_ms']} / {t['max_start_error_ms']} ms |"
        )
    out += ["", "## Worst utterances", ""]
    for r in results:
        out.append(f"### built-in VAD {'on' if r['builtin_vad'] else 'off'}")
        out.append("")
        for x in sorted(r["rows"], key=lambda x: -x["cer"])[:5]:
            out.append(
                f"- `{x['file']}` CER {x['cer'] * 100:.0f} %  \n  ref: {x['ref']}  \n  hyp: {x['hyp']}"
            )
        out.append("")
    out += [
        "## Notes",
        "",
        "- **Assumption**: read speech flatters every engine; live-selling speech (slang, sizes, music)"
        " is worse. Its accuracy is **not measured** yet — it needs a human-checked transcript"
        " (PROGRESS needs-user #8).",
        "- E01 used whisper-cli per file with the same model; small differences come from the server path "
        "and the warm process.",
        "",
    ]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True, help="Markdown report path")
    p.add_argument("--json", help="also write raw results (JSON)")
    args = p.parse_args()
    results = [run_config(True), run_config(False)]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report(results))
    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=1))
    for r in results:
        print(
            f"builtin_vad={r['builtin_vad']} cer={r['cer']:.4f} thanthakhat={r['thanthakhat_hyp']}/"
            f"{r['thanthakhat_ref']} rt={r['audio_ms'] / max(1, r['elapsed_ms']):.2f}x timing={r['timing']}"
        )
    print(f"report: {out}")


if __name__ == "__main__":
    main()
