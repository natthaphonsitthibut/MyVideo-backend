"""Settings from the environment (names are provider-neutral; see backend/.env.example)."""

import os
from dataclasses import dataclass, field
from pathlib import Path

_DEFAULT_MODELS = (
    Path(__file__).resolve().parents[5] / "models" / "asr"
)  # VideoAI/models/asr in the workspace


def _roots() -> list[Path]:
    raw = os.environ.get("AI_ALLOWED_ROOTS", "")
    roots = [Path(p).resolve() for p in raw.split(os.pathsep) if p.strip()]
    return roots


@dataclass(frozen=True)
class Settings:
    models_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("AI_MODELS_DIR", str(_DEFAULT_MODELS))).resolve()
    )
    whisper_cli: str = field(default_factory=lambda: os.environ.get("WHISPER_CLI", "whisper-cli"))
    vad_bin: str = field(
        default_factory=lambda: os.environ.get("WHISPER_VAD_BIN", "whisper-vad-speech-segments")
    )
    vad_model: str = field(default_factory=lambda: os.environ.get("VAD_MODEL", "ggml-silero-v6.2.0.bin"))
    asr_model: str = field(
        default_factory=lambda: os.environ.get("ASR_MODEL", "ggml-large-v3-turbo-q5_0.bin")
    )
    # Only files under these directories may be read (internal service, but paths still come from requests).
    allowed_roots: list[Path] = field(default_factory=_roots)


class PathNotAllowed(ValueError):
    pass


def checked_path(settings: Settings, path: str) -> Path:
    """Resolves `path` and refuses anything outside the allowed roots or not a regular file."""
    p = Path(path).resolve()
    if not settings.allowed_roots:
        raise PathNotAllowed("AI_ALLOWED_ROOTS is not configured")
    roots = [r.resolve() for r in settings.allowed_roots]
    if not any(p == r or r in p.parents for r in roots):
        raise PathNotAllowed(f"path outside allowed roots: {path}")
    if not p.is_file():
        raise PathNotAllowed(f"not a file: {path}")
    return p
