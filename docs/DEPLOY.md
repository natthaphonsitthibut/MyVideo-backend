# Deploying MyVideo on one server (runbook)

Status: **prepared, not deployed, images not yet built or tested** (E11-F08, 2026-11-12). Build and try it on a
machine with ≥ 16 GB RAM; the 8 GB development Mac builds one image at a time at most.

## Images

| Image | Built from | Contains |
|---|---|---|
| `myvideo-api` | `backend/docker/node.Dockerfile --target api` | NestJS API |
| `myvideo-worker` | `backend/docker/node.Dockerfile --target worker` | job worker + ffmpeg + Chromium (render, text layout) + stage bundle |
| `myvideo-ai` | `backend/docker/ai.Dockerfile` | VAD/ASR (whisper.cpp v1.9.5, CPU), shots, faces |
| `myvideo-web` | `frontend/Dockerfile` | built web app on nginx; proxies `/api` to the API |

```
docker build -f docker/node.Dockerfile --target api -t myvideo-api:v1 .      # in backend/
docker build -f docker/node.Dockerfile --target worker -t myvideo-worker:v1 .
docker build -f docker/ai.Dockerfile -t myvideo-ai:v1 .
docker build -t myvideo-web:v1 .                                             # in frontend/
```

## Environment (`.env.production`, never committed)

| Name | Required | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | database password (used by postgres and the app URL) |
| `SESSION_SECRET` | yes | ≥ 8 chars, not `change-me` (refused in production) |
| `MODELS_DIR` | yes | host folder with `asr/*.bin` (whisper + silero) and `vision/face_detection_yunet_2023mar.onnx` |
| `LLM_MODE` | no | `api` in production (default here) |
| `LLM_PROVIDER`, `LLM_API_KEY` | with `api` | hosted LLM provider + key |
| `MYVIDEO_VERSION` | no | image tag to run (default `latest`) |
| `HTTP_PORT` | no | public port of the web container (default 8080); put TLS in front (Caddy/nginx) |

Sound effects library: run `pnpm library:fetch` once into the `appdata` volume path `/data/library/sounds`.

## Start / migrate

```
docker compose -f docker-compose.deploy.yml --env-file .env.production up -d postgres redis
docker compose -f docker-compose.deploy.yml --env-file .env.production run --rm api \
  node node_modules/@myvideo/infra/node_modules/typeorm/cli.js migration:run -d node_modules/@myvideo/infra/dist/db/cli-data-source.js
docker compose -f docker-compose.deploy.yml --env-file .env.production up -d
```
(Assumption: the migration path inside the deployed api image; check it on the first build.)

## Daily cleanup

`pnpm cleanup` (dry run) / `pnpm cleanup --apply` — orphaned derived files after a grace day, renders older than
30 days except each project's newest, unfinished uploads older than 7 days. Originals are never deleted. Run it from
cron on the host with the same environment.

## Backup and restore

- Database: `docker compose exec postgres pg_dump -U myvideo -Fc myvideo > myvideo-YYYYMMDD.dump` daily;
  restore with `pg_restore -U myvideo -d myvideo --clean myvideo-YYYYMMDD.dump`.
- Files: back up the `appdata` volume's `/data/storage/m/*/sources/*/original.*` (originals). Everything else
  (proxies, audio, keyframes, renders) is derived and re-created by the jobs.
- Test a restore on a spare machine before relying on it.

## Rollback

Images are tagged per release (`MYVIDEO_VERSION`). Roll back = set the previous tag and `up -d`. A release whose
migrations changed the schema needs `pnpm db:revert` for each new migration **before** starting the old images;
take a database dump first.
