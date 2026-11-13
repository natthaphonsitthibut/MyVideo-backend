import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from myvideo_ai.app import create_app
from myvideo_ai.settings import Settings

WS = Path(__file__).resolve().parents[4]  # workspace root (VideoAI/)
TALKING = WS / "footage" / "clips" / "talkinghead-th-portrait.mp4"  # C03: one person talking to the camera
GPU = WS / "footage" / "clips" / "broll-gpu-unboxing-silent.mp4"  # C05: hands + a graphics card, no face
REAL = TALKING.is_file() and GPU.is_file()


def frame(video: Path, t: float, out: Path) -> Path:
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-ss",
            str(t),
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-vf",
            "scale=-2:360",
            str(out),
        ],
        check=True,
    )
    return out


def test_rejects_paths_outside_roots(tmp_path):
    client = TestClient(create_app(Settings(allowed_roots=[tmp_path])))
    assert client.post("/faces", json={"paths": ["/etc/hosts"]}).status_code == 400


@pytest.mark.skipif(not REAL, reason="real footage C03/C05 not present")
def test_face_on_real_talking_head_and_none_on_product_footage(tmp_path):
    client = TestClient(create_app(Settings(allowed_roots=[tmp_path])))
    talk = [frame(TALKING, t, tmp_path / f"talk-{t}.jpg") for t in (5.0, 20.0, 40.0)]
    gpu = [frame(GPU, t, tmp_path / f"gpu-{t}.jpg") for t in (2.0, 11.0, 18.0, 25.0)]
    res = client.post("/faces", json={"paths": [str(p) for p in talk + gpu]})
    assert res.status_code == 200
    body = res.json()
    assert body["engine"].startswith("opencv-yunet")
    imgs = body["images"]
    talk_hits = [i for i in imgs[:3] if i["faces"] > 0]
    gpu_hits = [i for i in imgs[3:] if i["faces"] > 0]
    # the talking head is found on most frames; the product shots have no face
    assert len(talk_hits) >= 2, imgs
    # C03 is a half-body shot: the face is ~0.9 % of the frame (measured); talking-head rule uses >= 0.4 %
    assert max(i["largest_ratio"] for i in talk_hits) >= 0.004, imgs
    assert gpu_hits == [], imgs
    # no face → no position
    assert all(i["center_x"] is None and i["center_y"] is None for i in imgs[3:]), imgs


@pytest.mark.skipif(not REAL, reason="real footage C03/C05 not present")
def test_face_centre_follows_where_the_face_is(tmp_path):
    """Real C03 frame placed at the left / right third of a wide black canvas (real pixels, placement made
    here): the reported centre must move with it — this is what the 16:9 → 9:16 crop uses."""
    talk = frame(TALKING, 20.0, tmp_path / "talk.jpg")  # 288x360
    out = {}
    for side, x in (("left", 0), ("right", 576)):
        img = tmp_path / f"wide-{side}.jpg"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(talk), "-vf", f"pad=864:360:{x}:0:black", str(img)],
            check=True,
        )
        out[side] = img
    client = TestClient(create_app(Settings(allowed_roots=[tmp_path])))
    imgs = client.post("/faces", json={"paths": [str(out["left"]), str(out["right"])]}).json()["images"]
    assert imgs[0]["faces"] > 0 and imgs[1]["faces"] > 0, imgs
    assert imgs[0]["center_x"] < 1 / 3 < 2 / 3 < imgs[1]["center_x"], imgs
    assert 0 < imgs[0]["center_y"] < 1, imgs
