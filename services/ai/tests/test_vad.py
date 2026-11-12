import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from myvideo_ai.app import create_app
from myvideo_ai.settings import Settings
from myvideo_ai.vad import parse_segments

WS = Path(__file__).resolve().parents[4]  # workspace root (VideoAI/)
LABELS = WS / "footage" / "labels" / "vad"
MODEL = WS / "models" / "asr" / "ggml-silero-v6.2.0.bin"
REAL = (LABELS / "fleurs-concat.wav").is_file() and MODEL.is_file()


def test_parse_segments_converts_centiseconds_and_merges_overlaps():
    text = (
        "Detected 3 speech segments:\n"
        "Speech segment 0: start = 90.00, end = 275.00\n"
        "Speech segment 1: start = 270.00, end = 300.00\n"
        "Speech segment 2: start = 352.00, end = 432.50\n"
    )
    assert parse_segments(text) == [(900, 3000), (3520, 4325)]


def test_rejects_paths_outside_allowed_roots(tmp_path):
    client = TestClient(create_app(Settings(allowed_roots=[tmp_path])))
    res = client.post("/vad", json={"path": "/etc/hosts"})
    assert res.status_code == 400
    assert "outside allowed roots" in res.json()["detail"]
    res = client.post("/vad", json={"path": str(tmp_path / "missing.wav")})
    assert res.status_code == 400


def _overlap(a: tuple[int, int], segs: list[dict]) -> int:
    return sum(max(0, min(a[1], s["end_ms"]) - max(a[0], s["start_ms"])) for s in segs)


@pytest.mark.skipif(not REAL, reason="needs workspace footage/labels and models/asr (not in CI)")
def test_vad_against_constructed_ground_truth():
    """Real Thai speech with pauses inserted at known times (footage/labels/vad, MANIFEST L01)."""
    labels = json.loads((LABELS / "fleurs-concat.labels.json").read_text())
    client = TestClient(create_app(Settings(allowed_roots=[LABELS], models_dir=MODEL.parent)))
    res = client.post("/vad", json={"path": str(LABELS / "fleurs-concat.wav")})
    assert res.status_code == 200
    segs = res.json()["segments"]
    # speech cores: FLEURS files have silence at both ends of each utterance (energy-trimmed in the labels)
    utt = [(u["speechStartMs"], u["speechEndMs"]) for u in labels["utterances"]]
    pauses = [(p["startMs"], p["endMs"]) for p in labels["pauses"]]
    covered = sum(_overlap(u, segs) for u in utt) / sum(e - s for s, e in utt)
    false_speech = sum(_overlap(p, segs) for p in pauses) / sum(e - s for s, e in pauses)
    print(f"VAD utterance coverage={covered:.3f} speech-in-pauses={false_speech:.3f} segments={len(segs)}")
    assert covered >= 0.85
    assert false_speech <= 0.10
    # every inserted pause of >= 2 s splits the speech: no segment spans a whole pause
    for p in pauses:
        assert not any(s["start_ms"] <= p[0] and s["end_ms"] >= p[1] for s in segs), p


@pytest.mark.skipif(not REAL, reason="needs workspace footage and models/asr")
def test_vad_on_real_live_clip_finds_speech(tmp_path):
    clip = WS / "footage" / "clips" / "live-tiedye-th-vertical-a.mp4"
    flac = tmp_path / "vad-live-a.flac"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-ac", "1", "-ar", "16000", str(flac)], check=True
    )
    client = TestClient(create_app(Settings(allowed_roots=[flac.parent], models_dir=MODEL.parent)))
    body = client.post("/vad", json={"path": str(flac)}).json()
    assert len(body["segments"]) >= 3
    assert 10_000 < body["speech_ms"] < 50_000  # 50 s clip of a live with talking and gaps
