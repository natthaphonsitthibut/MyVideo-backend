"""Voice activity detection with Silero VAD (ggml) through whisper.cpp's `whisper-vad-speech-segments`.

Chosen over the Python silero-vad package so no PyTorch is needed on the 8 GB dev machine (D-005, E04-F01).
"""

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .settings import Settings

_SEG = re.compile(r"Speech segment \d+: start = ([\d.]+), end = ([\d.]+)")


@dataclass(frozen=True)
class VadOptions:
    threshold: float = 0.5
    min_speech_ms: int = 250
    min_silence_ms: int = 300
    speech_pad_ms: int = 100


def parse_segments(text: str) -> list[tuple[int, int]]:
    """whisper.cpp prints times in centiseconds; returns (start_ms, end_ms) sorted, non-overlapping."""
    out = sorted((round(float(a) * 10), round(float(b) * 10)) for a, b in _SEG.findall(text))
    merged: list[tuple[int, int]] = []
    for s, e in out:
        if e <= s:
            continue
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def run_vad(
    settings: Settings, audio: Path, opts: VadOptions, timeout_s: float = 600
) -> list[tuple[int, int]]:
    model = settings.models_dir / settings.vad_model
    if not model.is_file():
        raise FileNotFoundError(f"VAD model missing: {model}")
    args = [
        settings.vad_bin,
        "-np",
        "-vm",
        str(model),
        "-f",
        str(audio),
        "-vt",
        str(opts.threshold),
        "-vspd",
        str(opts.min_speech_ms),
        "-vsd",
        str(opts.min_silence_ms),
        "-vp",
        str(opts.speech_pad_ms),
    ]
    res = subprocess.run(args, capture_output=True, text=True, timeout=timeout_s, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"VAD failed ({res.returncode}): {res.stderr.strip().splitlines()[-1:] or ''}")
    return parse_segments(res.stdout)
