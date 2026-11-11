# MyVideo AI service (internal)

Python 3.12 (uv) + FastAPI. Wraps inference (VAD, ASR, shot detection, Thai tokenisation). Listens on
127.0.0.1 only; the Node API/worker call it through `libs/infra` `AiServiceClient`.

```bash
uv sync                          # create .venv with pinned deps
uv run pytest && uv run ruff check && uv run ruff format --check
uv run python -m myvideo_ai      # AI_HOST / AI_PORT (default 127.0.0.1:8000)
```
