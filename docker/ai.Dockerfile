# Internal AI service (VAD, ASR, shots, faces) — E11-F08.
#   docker build -f docker/ai.Dockerfile -t myvideo-ai .
# Models are NOT in the image: mount the workspace `models/` at /models (asr/*.bin, vision/*.onnx).
# CPU build of whisper.cpp; a GPU server needs its own backend flags (decision record first).
FROM debian:bookworm-slim AS whisper
ARG WHISPER_VERSION=v1.9.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build /build -j2 --target whisper-cli whisper-server whisper-vad-speech-segments

FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /build/bin/whisper-cli /build/bin/whisper-server /build/bin/whisper-vad-speech-segments /usr/local/bin/
COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /usr/local/bin/uv
WORKDIR /app
COPY services/ai/pyproject.toml services/ai/uv.lock services/ai/README.md ./
COPY services/ai/src ./src
RUN uv sync --frozen --no-dev
ENV AI_MODELS_DIR=/models/asr PATH=/app/.venv/bin:$PATH
# never exposed publicly: the compose file keeps it on the internal network only
ENV AI_HOST=0.0.0.0 AI_PORT=8000
EXPOSE 8000
USER nobody
CMD ["python", "-m", "myvideo_ai"]
