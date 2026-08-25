#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null

mkdir -p .runtime/hermes .runtime/openclaw
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example; review it before exposing the UI."
fi

docker compose config -q
docker compose up -d --build
docker compose ps

for _ in {1..30}; do
  if docker compose exec -T butler-web node -e 'fetch("http://127.0.0.1:7531/api/health").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then
    published=$(docker compose port butler-web 7531 | head -n 1)
    echo "Agent Butler is ready: http://$published"
    exit 0
  fi
  sleep 2
done

echo "Agent Butler did not become healthy. Check: docker compose logs --tail=200" >&2
exit 1
