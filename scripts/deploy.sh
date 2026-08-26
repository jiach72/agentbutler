#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null

env_value() {
  local key="$1"
  [[ -f .env ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit }' .env
}

mkdir -p .runtime/hermes .runtime/openclaw
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example; review it before exposing the UI."
fi

compose_args=()
bridge_url="${BUTLER_HERMES_BRIDGE_URL:-$(env_value BUTLER_HERMES_BRIDGE_URL)}"
if [[ "$bridge_url" == *":8755" ]]; then
  # Prefer an already-running systemd forwarder; otherwise let Compose own it.
  if command -v systemctl >/dev/null 2>&1 &&
     [[ "$(systemctl --user is-active agent-butler-bridge-forward.service 2>/dev/null || true)" == "active" ]]; then
    echo "Using existing systemd bridge forwarder on :8755."
  elif command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':8755 '; then
    echo "Using an existing listener on :8755; Compose bridge-forward profile is skipped."
  else
    compose_args+=(--profile bridge-forward)
  fi
fi

compose() { docker compose "${compose_args[@]}" "$@"; }

if ! git diff --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "WARNING: deploying from a dirty worktree; record the commit and local diff before release." >&2
fi

# ---- 预检：提前暴露两类已知事故（见 docs/deployment-20260825.md 踩坑记录）----

# 坑4：HERMES_BUTLER_HOST 改成非回环会让 Hermes gateway 崩溃循环（代码强制 loopback）。
if [[ -f "$HOME/.hermes/.env" ]]; then
  hermes_host=$(grep -E '^HERMES_BUTLER_HOST=' "$HOME/.hermes/.env" | tail -n 1 | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "$hermes_host" && "$hermes_host" != "127.0.0.1" && "$hermes_host" != "localhost" ]]; then
    echo "WARNING: ~/.hermes/.env 的 HERMES_BUTLER_HOST=$hermes_host 不是 loopback，" >&2
    echo "         Bridge 会拒绝启动并进入崩溃循环；建议改回 HERMES_BUTLER_HOST=127.0.0.1。" >&2
  fi
fi

# 坑3：compose 变量优先级是 shell 环境 > .env。并行进程导出的 BUTLER_* 会静默覆盖 .env。
for var in BUTLER_FRAMEWORK BUTLER_HERMES_BRIDGE_URL BUTLER_HERMES_HOST_PATH BUTLER_DATA_VOLUME; do
  if [[ -n "${!var:-}" ]] && grep -qE "^${var}=" .env; then
    echo "WARNING: shell 环境变量 $var=${!var} 将覆盖 .env 中的同名值（compose 优先级高于 --env-file）。" >&2
  fi
done

hermes_host_path="${BUTLER_HERMES_HOST_PATH:-$(env_value BUTLER_HERMES_HOST_PATH)}"
hermes_host_path="${hermes_host_path:-./.runtime/hermes}"
# WSL 常见安装位置自动探测：.env.example 的相对目录适合无 Hermes 的只读部署，
# 但 WSL Hermes 通常位于用户家目录。只有仍使用默认相对路径时才自动替换，
# 明确指定的自定义路径不被覆盖。
if [[ "$hermes_host_path" == "./.runtime/hermes" && -d "$HOME/.hermes/hermes-agent" ]]; then
  hermes_host_path="$HOME/.hermes"
  export BUTLER_HERMES_HOST_PATH="$hermes_host_path"
  echo "Detected WSL Hermes at $hermes_host_path; using it for Compose mounts."
fi
if [[ "$hermes_host_path" != /* ]]; then
  hermes_host_path="$ROOT_DIR/$hermes_host_path"
fi
if [[ -n "$bridge_url" && ! -s "$hermes_host_path/agent-butler/bridge.token" ]]; then
  echo "ERROR: BUTLER_HERMES_BRIDGE_URL is configured but token is missing: $hermes_host_path/agent-butler/bridge.token" >&2
  echo "       Set BUTLER_HERMES_HOST_PATH to the Linux Hermes state directory." >&2
  exit 1
fi

# ---- 升级前备份数据卷（失败默认阻断部署）----
DATA_VOLUME="${BUTLER_DATA_VOLUME:-$(env_value BUTLER_DATA_VOLUME)}"
DATA_VOLUME="${DATA_VOLUME:-agent-butler-data}"
if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
  mkdir -p backups
  backup_name="butler-data-$(date +%Y%m%d-%H%M%S).tgz"
  echo "Backing up data volume '$DATA_VOLUME' to backups/$backup_name ..."
  was_running=false
  if [[ -n "$(compose ps -q butler-gateway butler-watch butler-web 2>/dev/null)" ]]; then
    compose stop >/dev/null
    was_running=true
  fi
  if docker run --rm -v "$DATA_VOLUME:/data:ro" -v "$PWD/backups:/backup" alpine \
      tar czf "/backup/$backup_name" -C /data .; then
    echo "Backup OK."
  else
    [[ "$was_running" == true ]] && compose start >/dev/null 2>&1 || true
    if [[ "${BUTLER_ALLOW_UNBACKED_DEPLOY:-$(env_value BUTLER_ALLOW_UNBACKED_DEPLOY)}" != "true" ]]; then
      echo "ERROR: 数据卷备份失败，已停止部署。设置 BUTLER_ALLOW_UNBACKED_DEPLOY=true 才可强制继续。" >&2
      exit 1
    fi
    echo "WARNING: 数据卷备份失败，按 BUTLER_ALLOW_UNBACKED_DEPLOY=true 继续。" >&2
  fi
  [[ "$was_running" == true ]] && echo "Existing containers were stopped for a consistent volume snapshot."
fi

compose config -q
compose up -d --build
compose ps

for _ in {1..30}; do
  web_ok=false
  gateway_ok=false
  watch_ok=false
  if compose exec -T butler-web node -e 'fetch("http://127.0.0.1:7531/api/health").then(async (r) => { const b = await r.json(); process.exit(r.ok && b.ok === true && b.gateway === true ? 0 : 1); }).catch(() => process.exit(1))' >/dev/null 2>&1; then web_ok=true; fi
  if compose exec -T butler-gateway node -e 'fetch("http://127.0.0.1:7532/healthz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then gateway_ok=true; fi
  if compose exec -T butler-watch node -e 'fetch("http://127.0.0.1:7533/healthz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then watch_ok=true; fi
  if [[ "$web_ok" == true && "$gateway_ok" == true && "$watch_ok" == true ]]; then
    published=$(compose port butler-web 7531 | head -n 1)
    echo "Agent Butler is ready: http://$published"
    exit 0
  fi
  sleep 2
done

echo "Agent Butler did not become healthy. Check: docker compose logs --tail=200" >&2
exit 1
