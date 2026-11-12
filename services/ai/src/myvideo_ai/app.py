"""FastAPI app. Bind to 127.0.0.1 only: this service is never exposed to the internet."""

import platform
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .asr import ENGINE, AsrBusyError, WhisperServer, decode_flags
from .settings import PathNotAllowed, Settings, checked_path
from .thai import segment_words
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
                    **s.__dict__, words=[WordOut(**w) for w in segment_words(s.text, s.start_ms, s.end_ms)]
                )
                for s in r.segments
            ],
            model=r.model,
            engine=r.engine,
            elapsed_ms=r.elapsed_ms,
        )

    return app


app = create_app()
