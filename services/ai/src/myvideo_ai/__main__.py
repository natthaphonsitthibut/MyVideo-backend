"""`uv run python -m myvideo_ai` — serve on AI_HOST:AI_PORT (default 127.0.0.1:8000)."""

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "myvideo_ai.app:app",
        host=os.environ.get("AI_HOST", "127.0.0.1"),
        port=int(os.environ.get("AI_PORT", "8000")),
        log_level=os.environ.get("AI_LOG_LEVEL", "info"),
        workers=1,
    )


if __name__ == "__main__":
    main()
