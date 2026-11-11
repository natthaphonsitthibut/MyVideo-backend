# MyVideo — backend

pnpm workspace: `apps/api` (NestJS HTTP), `apps/worker` (NestJS standalone), `libs/domain|contracts|infra`,
later `services/ai` (Python). Node ≥ 22, pnpm only.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # integration tests need Postgres + Redis running
pnpm build && pnpm start:api               # reads .env (copy .env.example)
```

`GET /health` → 200 when Postgres and Redis are up, 503 with the failing check otherwise.
