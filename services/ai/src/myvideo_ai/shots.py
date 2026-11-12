"""Shot (scene) detection + keyframes (E07-F05). PySceneDetect 0.7.2 on OpenCV, frames downscaled.

Detectors run together: ContentDetector (hard cuts, HSV change between frames) and ThresholdDetector
(fades to/from black, common in product b-roll), plus HashDetector. A time range lets the caller run a
long recording segment by segment with visible progress. Keyframes are JPEGs written by ffmpeg.
"""

import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from scenedetect import (
    AdaptiveDetector,
    ContentDetector,
    HashDetector,
    HistogramDetector,
    SceneManager,
    ThresholdDetector,
    open_video,
)

ENGINE = "pyscenedetect-0.7.2"
RECIPE = 1


@dataclass(frozen=True)
class ShotOptions:
    content_threshold: float = 27.0
    fade_threshold: float = 12.0
    histogram_threshold: float = 0.2
    hash_threshold: float = 0.35
    adaptive_threshold: float = 3.0
    min_shot_s: float = 0.6
    # chosen on S05 (agent-counted cuts): content+fade recall 0.79, +hash 0.96 (D-021)
    detectors: tuple[str, ...] = ("content", "fade", "hash")


@dataclass
class Shot:
    start_ms: int
    end_ms: int
    keyframes: list[dict] = field(default_factory=list)


@dataclass
class ShotResult:
    fps: float
    cuts_ms: list[int]
    shots: list[Shot]
    elapsed_ms: int


def detect_shots(
    video: Path,
    start_ms: int | None = None,
    end_ms: int | None = None,
    opts: ShotOptions | None = None,
) -> ShotResult:
    o = opts or ShotOptions()
    t0 = time.monotonic()
    stream = open_video(str(video))
    fps = float(stream.frame_rate)
    min_len = max(1, round(o.min_shot_s * fps))
    sm = SceneManager()
    sm.auto_downscale = True
    make = {
        "content": lambda: ContentDetector(threshold=o.content_threshold, min_scene_len=min_len),
        "fade": lambda: ThresholdDetector(threshold=o.fade_threshold, min_scene_len=min_len),
        "histogram": lambda: HistogramDetector(threshold=o.histogram_threshold, min_scene_len=min_len),
        "hash": lambda: HashDetector(threshold=o.hash_threshold, min_scene_len=min_len),
        "adaptive": lambda: AdaptiveDetector(adaptive_threshold=o.adaptive_threshold, min_scene_len=min_len),
    }
    for name in o.detectors:
        sm.add_detector(make[name]())
    if start_ms:
        stream.seek(start_ms / 1000.0)
    sm.detect_scenes(video=stream, end_time=(end_ms / 1000.0) if end_ms else None)
    scenes = sm.get_scene_list(start_in_scene=True)
    # several detectors can report the same transition a few frames apart: keep one cut per min_shot_s
    shots: list[Shot] = []
    for a, b in scenes:
        s, e = round(a.seconds * 1000), round(b.seconds * 1000)
        if shots and s - shots[-1].start_ms < o.min_shot_s * 1000:
            shots[-1].end_ms = e
        else:
            shots.append(Shot(s, e))
    if start_ms:
        shots = [s for s in shots if s.end_ms > start_ms]
        if shots:
            shots[0].start_ms = max(shots[0].start_ms, start_ms)
    cuts = [s.start_ms for s in shots[1:]]
    return ShotResult(fps=fps, cuts_ms=cuts, shots=shots, elapsed_ms=round((time.monotonic() - t0) * 1000))


def keyframe_times(start_ms: int, end_ms: int) -> list[int]:
    """1 keyframe for a shot < 3 s, 2 for < 8 s, else 3 — spread inside the shot, away from the edges."""
    length = end_ms - start_ms
    n = 1 if length < 3000 else 2 if length < 8000 else 3
    return [start_ms + round(length * (i + 1) / (n + 1)) for i in range(n)]


def extract_keyframes(video: Path, shots: list[Shot], out_dir: Path, height: int = 360) -> None:
    """Writes `kf-<start_ms>-<i>.jpg` per keyframe (accurate seek) and fills `shot.keyframes`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not found on PATH")
    for shot in shots:
        for i, t in enumerate(keyframe_times(shot.start_ms, shot.end_ms)):
            dest = out_dir / f"kf-{shot.start_ms:09d}-{i}.jpg"
            subprocess.run(
                [
                    ffmpeg,
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    f"{t / 1000:.3f}",
                    "-i",
                    str(video),
                    "-frames:v",
                    "1",
                    "-vf",
                    f"scale=-2:{height}",
                    "-q:v",
                    "4",
                    str(dest),
                ],
                check=True,
                capture_output=True,
                timeout=60,
            )
            shot.keyframes.append({"t_ms": t, "path": str(dest)})
