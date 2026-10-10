#!/bin/sh
# Container start (LLD §1.1): install deps if the lockfile changed, apply every migration, then —
# in development only, when SEED_ON_START=true — run the idempotent demo seed (src/db/seeds).
set -e
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi
npx knex migrate:latest
if [ "${SEED_ON_START:-false}" = "true" ] && [ "${NODE_ENV:-development}" != "production" ]; then
  npx knex seed:run
fi
exec "$@"
