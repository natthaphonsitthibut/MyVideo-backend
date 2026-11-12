import json
import resource
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from myvideo_ai.app import create_app
from myvideo_ai.asr import decode_flags, parse_verbose
from myvideo_ai.settings import Settings

WS = Path(__file__).resolve().parents[4]
MODELS = WS / "models" / "asr"
CLIP = WS / "footage" / "clips" / "talkinghead-th-portrait.mp4"
REAL = (MODELS / "ggml-large-v3-turbo-q5_0.bin").is_file() and CLIP.is_file()


def test_parse_verbose_sorts_and_drops_empty_segments():
    raw = {
        "language": "th",
        "duration": 20.0,
        "segments": [
            {"start": "4.1", "end": "6.0", "text": " สอง ", "avg_logprob": "-0.3", "no_speech_prob": "0.01"},
            {"start": "0.9", "end": "3.13", "text": "หนึ่ง"},
            {"start": "7", "end": "8", "text": "  "},
        ],
    }
    r = parse_verbose(raw, "m", 10)
    assert [(s.start_ms, s.end_ms, s.text) for s in r.segments] == [(900, 3130, "หนึ่ง"), (4100, 6000, "สอง")]
    assert r.duration_ms == 20000 and r.language == "th"


DTW_FIX = json.loads((Path(__file__).parent / "fixtures" / "asr-dtw-real.json").read_text())


def test_parse_verbose_keeps_dtw_token_times_in_ms():
    r = parse_verbose(DTW_FIX, "m", 10)
    seg = next(s for s in r.segments if s.text == "100...")
    assert seg.tokens == [("100", 3780), ("...", 5300)]
    assert all("".join(t for t, _ in s.tokens or []) == s.text for s in r.segments)


def test_parse_verbose_without_dtw_has_no_tokens():
    raw = {"segments": [{"start": 0, "end": 1, "text": "ก", "words": [{"word": "ก", "start": 0, "end": 1}]}]}
    assert parse_verbose(raw, "m", 1).segments[0].tokens is None


def test_parse_verbose_drops_special_tokens_and_rejects_text_mismatch():
    raw = {
        "segments": [
            {
                "start": 0,
                "end": 1,
                "text": " ก",
                "words": [{"word": "[_BEG_]", "t_dtw": 0}, {"word": " ก", "t_dtw": 10}],
            },
            {"start": 1, "end": 2, "text": "ข", "words": [{"word": "ค", "t_dtw": 120}]},
        ]
    }
    r = parse_verbose(raw, "m", 1)
    assert r.segments[0].tokens == [(" ก", 100)]
    assert r.segments[1].tokens is None  # tokens that do not rebuild the text are not trusted


def test_decode_flags_add_dtw_with_flash_attention_off():
    assert decode_flags(False, "vad.bin", "large.v3.turbo") == [
        "-mc",
        "0",
        "-sns",
        "-dtw",
        "large.v3.turbo",
        "-nfa",
    ]
    assert decode_flags(False, "vad.bin", "") == ["-mc", "0", "-sns"]
    # t_dtw is not remapped after the built-in VAD → no DTW with it (words fall back to the spread)
    assert "-dtw" not in decode_flags(True, "vad.bin", "large.v3.turbo")


@pytest.mark.skipif(not REAL, reason="needs models/asr and footage (not in CI)")
def test_asr_on_real_thai_clip(tmp_path):
    chunk = tmp_path / "chunk.flac"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(CLIP), "-ac", "1", "-ar", "16000", str(chunk)], check=True
    )
    app = create_app(Settings(allowed_roots=[tmp_path], models_dir=MODELS))
    with TestClient(app) as client:
        t0 = time.monotonic()
        res = client.post("/asr", json={"path": str(chunk)})
        wall = time.monotonic() - t0
        assert res.status_code == 200, res.text
        body = res.json()
        segs = body["segments"]
        assert body["language"] == "th"
        assert len(segs) >= 5
        starts = [s["start_ms"] for s in segs]
        assert starts == sorted(starts)
        assert all(s["end_ms"] > s["start_ms"] for s in segs)
        assert all(0 <= s["start_ms"] <= 55_000 for s in segs)
        words = [w for s in segs for w in s["words"]]
        assert len(words) > len(segs)
        assert [w["start_ms"] for w in words] == sorted(
            w["start_ms"] for w in words
        )  # monotonic word timings
        thai = "".join(s["text"] for s in segs)
        assert sum("฀" <= ch <= "๿" for ch in thai) > 100  # real Thai text came back
        # warm model: a second request is faster (no load)
        t1 = time.monotonic()
        assert client.post("/asr", json={"path": str(chunk)}).status_code == 200
        warm = time.monotonic() - t1
        pid = app.state.asr.proc.pid
        rss = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True
        ).stdout.strip()
        mem_mb = int(rss) // 1024
        py_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // (1024 * 1024)
        print(f"ASR first={wall:.1f}s warm={warm:.1f}s audio=54.5s rtf_warm={54.5 / warm:.1f}x")
        print(f"ASR whisper-server rss={mem_mb}MB python maxrss={py_mb}MB")
        assert 54.5 / warm >= 3  # D-005 gate: at least 3x realtime


@pytest.mark.skipif(not REAL, reason="needs models/asr and footage (not in CI)")
def test_refuses_a_concurrent_request(tmp_path):
    chunk = tmp_path / "c.flac"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(CLIP), "-t", "30", "-ac", "1", "-ar", "16000", str(chunk)],
        check=True,
    )
    app = create_app(Settings(allowed_roots=[tmp_path], models_dir=MODELS))
    with TestClient(app) as client:
        results: list[int] = []
        t = threading.Thread(
            target=lambda: results.append(client.post("/asr", json={"path": str(chunk)}).status_code)
        )
        t.start()
        time.sleep(0.3)
        second = client.post("/asr", json={"path": str(chunk)})
        t.join()
        assert results == [200]
        assert second.status_code == 409
