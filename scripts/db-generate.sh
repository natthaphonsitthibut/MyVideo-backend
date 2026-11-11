#!/usr/bin/env bash
# Generate a migration from entity changes: pnpm db:generate <Name>
# Then add the new class to libs/infra/src/db/migrations/index.ts and review the SQL.
set -euo pipefail
cd "$(dirname "$0")/.."
name="${1:?usage: pnpm db:generate <Name>}"
[ -f .env ] && set -a && . ./.env && set +a
pnpm --filter @myvideo/infra build >/dev/null
node libs/infra/node_modules/typeorm/cli.js migration:generate -d libs/infra/dist/db/cli-data-source.js \
  "libs/infra/src/db/migrations/$name"
pnpm exec biome check --write libs/infra/src/db/migrations >/dev/null
