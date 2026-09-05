#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null

env_value() {
  local key="$1"
  [[ -f .env ]] || return 0
  # `.env` is often edited on Windows and may use CRLF; never leak `\r` into
  # paths, URLs, or Compose values when this script runs inside WSL.
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); sub(/\r$/, ""); gsub(/^"|"$/, ""); print; exit }' .env
}
env_set() {
  local key="$1" value="$2" env_tmp
  env_tmp="$(mktemp .env.XXXXXX)"
  awk -F= -v key="$key" -v value="$value" '
    $1 == key { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$env_tmp"
  mv "$env_tmp" .env
}

mkdir -p .runtime/hermes .runtime/openclaw
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example; review it before exposing the UI."
fi

# 初始化凭据库主密钥。首次部署自动生成并持久化，后续部署绝不轮换，
# 否则历史 API Key 将无法解密。密钥值不打印到终端或日志。
file_master_key="$(env_value BUTLER_SECRET_MASTER_KEY)"
shell_master_key="${BUTLER_SECRET_MASTER_KEY:-}"
if [[ -n "$file_master_key" && -n "$shell_master_key" && "$file_master_key" != "$shell_master_key" ]]; then
  echo "ERROR: shell 与 .env 中的 BUTLER_SECRET_MASTER_KEY 不一致；为避免历史凭据无法解密，请只保留同一个值。" >&2
  exit 1
fi
master_key="${file_master_key:-$shell_master_key}"
if [[ -n "$master_key" && ! "$master_key" =~ ^[a-fA-F0-9]{64}$ && ! "$master_key" =~ ^([A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{44}|[A-Za-z0-9_-]{43,44})$ ]]; then
  echo "ERROR: BUTLER_SECRET_MASTER_KEY 格式无效；需要 32 字节 hex 或 base64/base64url。" >&2
  exit 1
fi
if [[ -z "$master_key" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    master_key=$(openssl rand -hex 32)
  elif command -v node >/dev/null 2>&1; then
    master_key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  else
    echo "ERROR: 无法生成凭据库主密钥，请安装 openssl 或 Node.js 22+ 后重试。" >&2
    exit 1
  fi
  if grep -qE '^BUTLER_SECRET_MASTER_KEY=' .env; then
    env_tmp="$(mktemp .env.XXXXXX)"
    awk -v value="$master_key" 'BEGIN { done = 0 } /^BUTLER_SECRET_MASTER_KEY=/ { print "BUTLER_SECRET_MASTER_KEY=" value; done = 1; next } { print } END { if (!done) print "BUTLER_SECRET_MASTER_KEY=" value }' .env > "$env_tmp"
    mv "$env_tmp" .env
  else
    printf '\nBUTLER_SECRET_MASTER_KEY=%s\n' "$master_key" >> .env
  fi
  chmod 600 .env 2>/dev/null || true
  echo "Generated and stored the Butler credential vault key in .env."
fi
export BUTLER_SECRET_MASTER_KEY="$master_key"

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

# Docker Desktop's Buildx plugin can be unavailable in WSL when its mounted
# binary reports an I/O error. Compose can still build through the classic
# Docker builder, so fall back explicitly instead of failing the deployment.
if ! docker buildx version >/dev/null 2>&1; then
  export DOCKER_BUILDKIT=0
  export COMPOSE_DOCKER_CLI_BUILD=0
  echo "WARNING: Docker Buildx is unavailable; using the classic Docker builder." >&2
fi

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
  # 持久化到 .env：手动 docker compose 命令与 UI 一键升级（updater sidecar）
  # 不带本次 shell 的环境覆盖，若只运行时注入会让 gateway 挂载空目录并崩溃循环
  # （cannot access BUTLER_HERMES_BRIDGE_TOKEN_FILE）。
  if grep -qE '^BUTLER_HERMES_HOST_PATH=' .env; then
    env_tmp="$(mktemp .env.XXXXXX)"
    awk -v value="$hermes_host_path" '/^BUTLER_HERMES_HOST_PATH=/ { print "BUTLER_HERMES_HOST_PATH=" value; next } { print }' .env > "$env_tmp"
    mv "$env_tmp" .env
  else
    printf '\nBUTLER_HERMES_HOST_PATH=%s\n' "$hermes_host_path" >> .env
  fi
  echo "Detected WSL Hermes at $hermes_host_path; persisted to .env for Compose mounts."
fi
if [[ "$hermes_host_path" != /* ]]; then
  hermes_host_path="$ROOT_DIR/$hermes_host_path"
fi
# WSL 原生 Docker 通过宿主控制桥执行 Hermes 生命周期动作。
# 仅在真实 Hermes systemd user unit 存在时安装，避免对未知服务执行命令。
control_url="${BUTLER_HERMES_CONTROL_URL:-$(env_value BUTLER_HERMES_CONTROL_URL)}"
control_token_container="${BUTLER_HERMES_CONTROL_TOKEN_FILE:-$(env_value BUTLER_HERMES_CONTROL_TOKEN_FILE)}"
control_token_container="${control_token_container:-/home/butler/hermes/agent-butler/control.token}"
if [[ "$hermes_host_path" == "$HOME/.hermes" ]] && command -v systemctl >/dev/null 2>&1 &&
   systemctl --user cat hermes-gateway.service >/dev/null 2>&1; then
  bash scripts/install-hermes-control-bridge.sh
  if [[ -z "$control_url" ]]; then
    control_url="http://host.docker.internal:8757"
    env_set BUTLER_HERMES_CONTROL_URL "$control_url"
  fi
  if [[ -z "$(env_value BUTLER_HERMES_CONTROL_TOKEN_FILE)" ]]; then
    env_set BUTLER_HERMES_CONTROL_TOKEN_FILE "$control_token_container"
  fi
  export BUTLER_HERMES_CONTROL_URL="$control_url"
  export BUTLER_HERMES_CONTROL_TOKEN_FILE="$control_token_container"
  echo "Hermes 宿主控制桥已安装；Watch 将通过受限白名单接口执行一键修复。"
fi
if [[ "$control_url" == *":8757" ]]; then
  compose_args+=(--profile hermes-control-forward)
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
      tar czf "/backup/$backup_name" --exclude "./backups" -C /data .; then
    echo "Backup OK."
    # 备份保留策略：只留最近 BUTLER_BACKUP_KEEP 份（默认 4），防止每次部署 +数 GB 永久累积。
    backup_keep="${BUTLER_BACKUP_KEEP:-4}"
    ls -1t backups/butler-data-*.tgz 2>/dev/null | tail -n +"$((backup_keep + 1))" | while IFS= read -r old; do
      rm -f "$old" && echo "Pruned old backup: $old"
    done
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
    # Windows 宿主经 WSL portproxy 访问面板；WSL 重启换 IP 后浏览器会打不开 7531，
    # 提前给出可自助执行的修复命令（AGENTS.md 故障对照同款）。
    if grep -qiE '(microsoft|WSL)' /proc/version 2>/dev/null; then
      echo "提示：Windows 浏览器打不开面板时，多为 WSL IP 变化导致 portproxy 失效；"
      echo "      在管理员 PowerShell 执行 scripts/fix-portproxy.ps1 即可恢复。"
    fi
    # 消息网关链路状态：只提示，不阻断部署。Gateway 在 Bridge 离线时按设计
    # 持续重试并自动接回（见 AGENTS.md 第 3 节），这里给部署者一个明确信号。
    if [[ -n "$bridge_url" ]]; then
      bridge_state=$(compose exec -T butler-gateway node -e \
        'fetch("http://127.0.0.1:7532/healthz").then(async (r) => { const b = await r.json(); process.stdout.write(String(b.message && b.message.connected === true ? "true" : "false")); }).catch(() => process.stdout.write("unknown"))' \
        2>/dev/null || echo unknown)
      if [[ "$bridge_state" == "true" ]]; then
        echo "消息网关已连接 Hermes Bridge。"
      else
        echo "WARNING: 消息网关尚未连上 Hermes Bridge（当前状态: $bridge_state）。" >&2
        echo "         Gateway 会每秒自动重试，Bridge 就绪后自动接回；排查: bash scripts/bridge-healthcheck.sh" >&2
      fi
    fi
    exit 0
  fi
  sleep 2
done

echo "Agent Butler did not become healthy." >&2
# 直接给出未就绪服务的日志尾部：web/gateway 的 fail-closed 检查（如无口令公开、
# token 文件不可达）只在容器日志里有清晰指引，部署者不必再手动翻全量日志。
for pair in "butler-web:$web_ok" "butler-gateway:$gateway_ok" "butler-watch:$watch_ok"; do
  svc="${pair%%:*}"
  ok="${pair##*:}"
  if [[ "$ok" != true ]]; then
    echo "---- $svc 未就绪，最近日志 ----" >&2
    compose logs --tail=30 "$svc" >&2 || true
  fi
done
echo "Full logs: docker compose logs --tail=200" >&2
exit 1
