"""FastAPI app. Bind to 127.0.0.1 only: this service is never exposed to the internet."""

import platform
import sys

from fastapi import FastAPI
from pydantic import BaseModel

from . import __version__


class Health(BaseModel):
    status: str
    service: str
    version: str
    python: str


def create_app() -> FastAPI:
    app = FastAPI(title="MyVideo AI", version=__version__, docs_url=None, redoc_url=None)

    @app.get("/health")
    def health() -> Health:
        return Health(
            status="ok",
            service="myvideo-ai",
            version=__version__,
            python=f"{platform.python_version()} ({sys.platform})",
        )

    return app


app = create_app()
