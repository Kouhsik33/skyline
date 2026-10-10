#!/bin/sh
# Runs the Playwright suite in the official image on the compose network, against the
# production frontend container. Usage (repo root): docker compose up -d --build && e2e/run-in-docker.sh
set -e
cd "$(dirname "$0")"
exec docker run --rm --network soms_default -e E2E_BASE_URL=http://frontend -e CI=1 \
  -v "$PWD":/e2e -w /e2e mcr.microsoft.com/playwright:v1.49.1-jammy \
  sh -c 'npm install --no-audit --no-fund --silent && npx playwright test "$@"' -- "$@"
