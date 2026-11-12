"""Face presence on keyframes (E10-F04): a cheap local signal for "talking head" shots.

OpenCV 5 dropped the Haar cascades; it ships YuNet (`cv2.FaceDetectorYN`), which needs its ONNX file:
`models/vision/face_detection_yunet_2023mar.onnx` (opencv_zoo, MIT, ~230 KB, sha256 in docs/TECH_STACK.md).
We only need "is there a face, and how big": the share of the frame covered by the largest face.
"""

from dataclasses import dataclass
from pathlib import Path

import cv2

YUNET_FILE = "face_detection_yunet_2023mar.onnx"
FACES_ENGINE = f"opencv-yunet-2023mar/{cv2.__version__}"
MIN_SCORE = 0.8


@dataclass
class FaceStats:
    faces: int
    largest_ratio: float  # largest face box area / frame area, 0..1


def face_stats(image: Path, model: Path) -> FaceStats:
    img = cv2.imread(str(image), cv2.IMREAD_COLOR)
    if img is None:
        raise OSError(f"cannot read image {image}")
    h, w = img.shape[:2]
    det = cv2.FaceDetectorYN.create(str(model), "", (w, h), MIN_SCORE, 0.3, 50)
    _, faces = det.detect(img)
    if faces is None or len(faces) == 0:
        return FaceStats(faces=0, largest_ratio=0.0)
    # faces smaller than ~6 % of the short side are crowd/background, not someone talking to the camera
    min_side = min(h, w) * 0.06
    sizes = [float(f[2]) * float(f[3]) for f in faces if min(float(f[2]), float(f[3])) >= min_side]
    if not sizes:
        return FaceStats(faces=0, largest_ratio=0.0)
    return FaceStats(faces=len(sizes), largest_ratio=round(max(sizes) / float(w * h), 4))
