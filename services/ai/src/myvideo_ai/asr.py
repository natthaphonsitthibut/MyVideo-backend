"""Thai ASR with whisper.cpp (D-005): a warm `whisper-server` child process, started on first use.

One request at a time (8 GB machine): a second concurrent request is refused with AsrBusyError instead of
queuing inside this process; the job system retries it.
"""

import json
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

from .settings import Settings

ENGINE = "whisper.cpp"
# Anti-loop flags chosen in E01-F03 (no carried context, suppress non-speech tokens) + whisper.cpp's built-in
# silero VAD segmentation. The built-in VAD can be switched off (ASR_BUILTIN_VAD=0): whisper.cpp 1.9.5 drops
# the Thai mark ์ on some audio with it (D-017); chunks are already cut at silences by our own VAD.
BASE_FLAGS = ["-mc", "0", "-sns"]
BUILTIN_VAD_FLAGS = ["--vad", "-vmsd", "30"]
TUNED_FLAGS = [*BASE_FLAGS, *BUILTIN_VAD_FLAGS]


def decode_flags(builtin_vad: bool, vad_model: Path | str) -> list[str]:
    """whisper-server decoding flags for the chosen configuration."""
    if not builtin_vad:
        return list(BASE_FLAGS)
    return [*BASE_FLAGS, *BUILTIN_VAD_FLAGS, "-vm", str(vad_model)]


class AsrBusyError(RuntimeError):
    pass


@dataclass
class AsrSegment:
    start_ms: int
    end_ms: int
    text: str
    avg_logprob: float | None
    no_speech_prob: float | None


@dataclass
class AsrResult:
    language: str
    duration_ms: int
    segments: list[AsrSegment]
    model: str
    engine: str
    elapsed_ms: int


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{path.name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n".encode()
    )
    parts.append(path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


_ISO = {"thai": "th", "english": "en"}


def parse_verbose(raw: dict, model: str, elapsed_ms: int) -> AsrResult:
    """whisper-server verbose_json → result. Segment times are seconds (already on the input timeline)."""
    segs = []
    for s in raw.get("segments", []):
        text = str(s.get("text", "")).strip()
        if not text:
            continue
        segs.append(
            AsrSegment(
                start_ms=round(float(s["start"]) * 1000),
                end_ms=round(float(s["end"]) * 1000),
                text=text,
                avg_logprob=float(s["avg_logprob"]) if "avg_logprob" in s else None,
                no_speech_prob=float(s["no_speech_prob"]) if "no_speech_prob" in s else None,
            )
        )
    segs.sort(key=lambda x: x.start_ms)
    lang = str(raw.get("language") or raw.get("detected_language") or "th").lower()
    return AsrResult(
        language=_ISO.get(lang, lang),
        duration_ms=round(float(raw.get("duration", 0)) * 1000),
        segments=segs,
        model=model,
        engine=ENGINE,
        elapsed_ms=elapsed_ms,
    )


class WhisperServer:
    """Owns the whisper-server child process (one per AI service process)."""

    def __init__(self, settings: Settings, language: str = "th") -> None:
        self.settings = settings
        self.language = language
        self.proc: subprocess.Popen[bytes] | None = None
        self.port = 0
        self._start_lock = threading.Lock()
        self._busy = threading.Lock()

    @property
    def model_name(self) -> str:
        return self.settings.asr_model

    def _ensure_started(self) -> None:
        with self._start_lock:
            if self.proc and self.proc.poll() is None:
                return
            model = self.settings.models_dir / self.settings.asr_model
            vad = self.settings.models_dir / self.settings.vad_model
            for f in (model, vad) if self.settings.asr_builtin_vad else (model,):
                if not f.is_file():
                    raise FileNotFoundError(f"model missing: {f}")
            self.port = _free_port()
            args = [
                self.settings.whisper_server,
                "-m",
                str(model),
                "-l",
                self.language,
                "-t",
                "4",
                *decode_flags(self.settings.asr_builtin_vad, vad),
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
            ]
            self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"whisper-server exited with {self.proc.returncode}")
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=1)
                    return
                except urllib.error.HTTPError:
                    return  # it answers → ready
                except OSError:
                    time.sleep(0.3)
            raise RuntimeError("whisper-server did not start in 120 s")

    def transcribe(self, audio: Path, timeout_s: float = 1800) -> AsrResult:
        if not self._busy.acquire(blocking=False):
            raise AsrBusyError("ASR is busy with another chunk")
        try:
            self._ensure_started()
            body, ctype = _multipart({"response_format": "verbose_json", "temperature": "0"}, "file", audio)
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.port}/inference",
                data=body,
                headers={"Content-Type": ctype},
                method="POST",
            )
            t0 = time.monotonic()
            with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310
                raw = json.loads(res.read().decode("utf-8", "replace"))
            return parse_verbose(raw, self.model_name, round((time.monotonic() - t0) * 1000))
        finally:
            self._busy.release()

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
