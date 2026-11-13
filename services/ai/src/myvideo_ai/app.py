"""FastAPI app. Bind to 127.0.0.1 only: this service is never exposed to the internet."""

import platform
import subprocess
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .asr import ENGINE, AsrBusyError, WhisperServer, decode_flags
from .faces import FACES_ENGINE, YUNET_FILE, face_stats
from .settings import PathNotAllowed, Settings, checked_dir, checked_path
from .shots import ENGINE as SHOTS_ENGINE
from .shots import RECIPE as SHOTS_RECIPE
from .shots import detect_shots, extract_keyframes
from .thai import numbers_to_digits, segment_words
from .vad import VadOptions, run_vad


class Health(BaseModel):
    status: str
    service: str
    version: str
    python: str


class AsrInfo(BaseModel):
    engine: str
    model: str
    language: str
    flags: str


class VadRequest(BaseModel):
    path: str = Field(description="Local path of an audio file (16 kHz mono FLAC/WAV recommended)")
    threshold: float = Field(0.5, ge=0.05, le=0.95)
    min_silence_ms: int = Field(300, ge=50, le=5000)
    min_speech_ms: int = Field(250, ge=50, le=5000)
    speech_pad_ms: int = Field(100, ge=0, le=1000)


class Segment(BaseModel):
    start_ms: int
    end_ms: int


class AsrRequest(BaseModel):
    path: str = Field(description="Local audio chunk (16 kHz mono FLAC/WAV)")


class WordOut(BaseModel):
    text: str
    start_ms: int
    end_ms: int
    kind: str


class AsrSegmentOut(BaseModel):
    start_ms: int
    end_ms: int
    text: str
    words: list[WordOut]
    avg_logprob: float | None
    no_speech_prob: float | None


class AsrResponse(BaseModel):
    language: str
    duration_ms: int
    segments: list[AsrSegmentOut]
    model: str
    engine: str
    elapsed_ms: int


class ShotsRequest(BaseModel):
    path: str = Field(description="Local video file (original or proxy)")
    start_ms: int | None = Field(None, ge=0, description="Analyse from here (segment-wise runs)")
    end_ms: int | None = Field(None, gt=0)
    keyframes_dir: str | None = Field(None, description="Write 1-3 JPEG keyframes per shot here")


class KeyframeOut(BaseModel):
    t_ms: int
    path: str


class ShotOut(BaseModel):
    start_ms: int
    end_ms: int
    keyframes: list[KeyframeOut]


class ShotsResponse(BaseModel):
    engine: str
    recipe: int
    fps: float
    cuts_ms: list[int]
    shots: list[ShotOut]
    elapsed_ms: int


class FacesRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=200, description="Local keyframe images")


class FaceOut(BaseModel):
    path: str
    faces: int
    largest_ratio: float
    center_x: float | None = None
    center_y: float | None = None


class FacesResponse(BaseModel):
    engine: str
    images: list[FaceOut]


class VadResponse(BaseModel):
    segments: list[Segment]
    speech_ms: int
    model: str


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or Settings()
    asr = WhisperServer(cfg)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        asr.stop()  # never leave the model process behind

    app = FastAPI(title="MyVideo AI", version=__version__, docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.asr = asr

    @app.get("/health")
    def health() -> Health:
        return Health(
            status="ok",
            service="myvideo-ai",
            version=__version__,
            python=f"{platform.python_version()} ({sys.platform})",
        )

    @app.get("/asr/info")
    def asr_info() -> AsrInfo:
        """What `/asr` would run, without loading the model (callers use it as a cache key)."""
        return AsrInfo(
            engine=ENGINE,
            model=asr.model_name,
            language=asr.language,
            flags=" ".join(decode_flags(cfg.asr_builtin_vad, cfg.vad_model)),
        )

    @app.post("/vad")
    def vad(req: VadRequest) -> VadResponse:
        try:
            audio = checked_path(cfg, req.path)
        except PathNotAllowed as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        opts = VadOptions(req.threshold, req.min_speech_ms, req.min_silence_ms, req.speech_pad_ms)
        try:
            segs = run_vad(cfg, audio, opts)
        except (RuntimeError, FileNotFoundError) as err:
            raise HTTPException(status_code=500, detail=str(err)) from err
        return VadResponse(
            segments=[Segment(start_ms=s, end_ms=e) for s, e in segs],
            speech_ms=sum(e - s for s, e in segs),
            model=cfg.vad_model,
        )

    @app.post("/shots")
    def shots(req: ShotsRequest) -> ShotsResponse:
        try:
            video = checked_path(cfg, req.path)
            out_dir = checked_dir(cfg, req.keyframes_dir) if req.keyframes_dir else None
        except PathNotAllowed as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        if req.start_ms is not None and req.end_ms is not None and req.end_ms <= req.start_ms:
            raise HTTPException(status_code=400, detail="end_ms must be after start_ms")
        try:
            r = detect_shots(video, req.start_ms, req.end_ms)
            if out_dir is not None:
                extract_keyframes(video, r.shots, out_dir)
        except (RuntimeError, OSError, subprocess.SubprocessError) as err:
            raise HTTPException(status_code=500, detail=str(err)) from err
        return ShotsResponse(
            engine=SHOTS_ENGINE,
            recipe=SHOTS_RECIPE,
            fps=r.fps,
            cuts_ms=r.cuts_ms,
            shots=[ShotOut(start_ms=s.start_ms, end_ms=s.end_ms, keyframes=s.keyframes) for s in r.shots],
            elapsed_ms=r.elapsed_ms,
        )

    @app.post("/faces")
    def faces(req: FacesRequest) -> FacesResponse:
        try:
            images = [checked_path(cfg, p) for p in req.paths]
        except PathNotAllowed as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        model = cfg.models_dir.parent / "vision" / YUNET_FILE
        if not model.is_file():
            raise HTTPException(status_code=503, detail=f"face model not installed: {model}")
        out: list[FaceOut] = []
        for img in images:
            try:
                st = face_stats(img, model)
            except OSError as err:
                raise HTTPException(status_code=400, detail=str(err)) from err
            out.append(
                FaceOut(
                    path=str(img),
                    faces=st.faces,
                    largest_ratio=st.largest_ratio,
                    center_x=st.center_x,
                    center_y=st.center_y,
                )
            )
        return FacesResponse(engine=FACES_ENGINE, images=out)

    @app.post("/asr")
    def transcribe(req: AsrRequest) -> AsrResponse:
        try:
            audio = checked_path(cfg, req.path)
        except PathNotAllowed as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        try:
            r = asr.transcribe(audio)
        except AsrBusyError as err:
            raise HTTPException(status_code=409, detail=str(err)) from err
        except (RuntimeError, FileNotFoundError, OSError) as err:
            raise HTTPException(status_code=500, detail=str(err)) from err
        return AsrResponse(
            language=r.language,
            duration_ms=r.duration_ms,
            segments=[
                AsrSegmentOut(
                    start_ms=s.start_ms,
                    end_ms=s.end_ms,
                    text=numbers_to_digits(s.text),
                    avg_logprob=s.avg_logprob,
                    no_speech_prob=s.no_speech_prob,
                    words=[WordOut(**w) for w in segment_words(s.text, s.start_ms, s.end_ms, s.tokens)],
                )
                for s in r.segments
            ],
            model=r.model,
            engine=r.engine,
            elapsed_ms=r.elapsed_ms,
        )

    return app


app = create_app()
