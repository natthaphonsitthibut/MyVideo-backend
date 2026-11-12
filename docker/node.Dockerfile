# API and worker image (E11-F08). One image, two targets:
#   docker build -f docker/node.Dockerfile --target api    -t myvideo-api .
#   docker build -f docker/node.Dockerfile --target worker -t myvideo-worker .
# Build ONE image at a time on an 8 GB machine.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY libs/contracts/package.json libs/contracts/
COPY libs/domain/package.json libs/domain/
COPY libs/infra/package.json libs/infra/
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY libs libs
RUN pnpm -r --workspace-concurrency=1 run build \
 && pnpm deploy --filter @myvideo/api --prod /out/api \
 && pnpm deploy --filter @myvideo/worker --prod /out/worker

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./
# migrations run from the infra package inside the deployed api
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM node:22-bookworm-slim AS worker
ENV NODE_ENV=production
# ffmpeg for media; Chromium (render + text layout) with its system libraries; Thai/Latin fonts come with the stage
# bundle, never from the system (ARCHITECTURE §7)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/worker ./
COPY stage-bundle /app/stage-bundle
ENV STAGE_BUNDLE_DIR=/app/stage-bundle PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate \
 && pnpm dlx playwright@1.65.0 install --with-deps chromium \
 && chown -R node:node /ms-playwright
USER node
CMD ["node", "dist/main.js"]
