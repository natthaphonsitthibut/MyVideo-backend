import itertools
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from myvideo_ai.app import create_app
from myvideo_ai.settings import Settings
from myvideo_ai.shots import keyframe_times

WS = Path(__file__).resolve().parents[4]  # workspace root (VideoAI/)
S05 = WS / "footage" / "stock" / "asus-gpu-unboxing.webm"
LABELS = WS / "footage" / "labels" / "shots" / "S05.shots.json"
REAL = S05.is_file() and LABELS.is_file()


def test_keyframe_count_and_placement():
    assert keyframe_times(0, 2000) == [1000]
    assert keyframe_times(1000, 7000) == [3000, 5000]
    assert keyframe_times(0, 20000) == [5000, 10000, 15000]
    for a, b in [(0, 900), (5000, 5600), (0, 60000)]:
        assert all(a < t < b for t in keyframe_times(a, b))


def test_rejects_paths_and_dirs_outside_roots(tmp_path):
    client = TestClient(create_app(Settings(allowed_roots=[tmp_path])))
    assert client.post("/shots", json={"path": "/etc/hosts"}).status_code == 400
    (tmp_path / "x.mp4").write_bytes(b"not a video")
    res = client.post(
        "/shots", json={"path": str(tmp_path / "x.mp4"), "keyframes_dir": str(tmp_path.parent / "elsewhere")}
    )
    assert res.status_code == 400
    res = client.post("/shots", json={"path": str(tmp_path / "x.mp4"), "start_ms": 5000, "end_ms": 1000})
    assert res.status_code == 400


def _recall(cuts_s: list[float], truth: list[float], tol: float) -> tuple[int, list[float]]:
    used: set[int] = set()
    hits = 0
    for t in truth:
        near = [i for i, d in enumerate(cuts_s) if abs(d - t) <= tol and i not in used]
        if near:
            used.add(min(near, key=lambda i: abs(cuts_s[i] - t)))
            hits += 1
    return hits, [t for t in truth if not any(abs(d - t) <= tol for d in cuts_s)]


@pytest.mark.skipif(not REAL, reason="needs workspace footage (not in CI)")
def test_recall_on_real_broll_with_counted_cuts(tmp_path):
    """S05 (CC BY 3.0 unboxing b-roll, 105 s): 24 transitions counted by the agent on 2 fps contact sheets."""
    labels = json.loads(LABELS.read_text())
    truth = [c["t"] for c in labels["cuts"]]
    client = TestClient(create_app(Settings(allowed_roots=[S05.parent, tmp_path])))
    res = client.post("/shots", json={"path": str(S05), "keyframes_dir": str(tmp_path / "kf")})
    assert res.status_code == 200
    body = res.json()
    hits, missed = _recall([c / 1000 for c in body["cuts_ms"]], truth, labels["match_tolerance_s"])
    recall = hits / len(truth)
    print(
        f"S05 recall={hits}/{len(truth)}={recall:.2f} detected={len(body['cuts_ms'])} missed={missed} "
        f"elapsed={body['elapsed_ms']}ms"
    )
    assert recall >= 0.9
    # shots tile the clip, keyframes exist and sit inside their shot
    shots = body["shots"]
    assert shots[0]["start_ms"] == 0
    for a, b in itertools.pairwise(shots):
        assert a["end_ms"] == b["start_ms"]
    for s in shots:
        assert 1 <= len(s["keyframes"]) <= 3
        for k in s["keyframes"]:
            assert s["start_ms"] < k["t_ms"] < s["end_ms"]
            assert Path(k["path"]).stat().st_size > 1000


@pytest.mark.skipif(not REAL, reason="needs workspace footage (not in CI)")
def test_time_range_only_reports_cuts_inside_it():
    client = TestClient(create_app(Settings(allowed_roots=[S05.parent])))
    res = client.post("/shots", json={"path": str(S05), "start_ms": 40_000, "end_ms": 60_000})
    assert res.status_code == 200
    body = res.json()
    assert body["shots"][0]["start_ms"] == 40_000
    assert all(40_000 < c <= 60_100 for c in body["cuts_ms"])
    assert len(body["cuts_ms"]) >= 3  # 43.75, 49.25, 52.75, 56.75 counted in this range
