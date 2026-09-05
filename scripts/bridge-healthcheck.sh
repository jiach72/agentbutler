#!/usr/bin/env bash
# Agent Butler 消息链路体检：token → bridge(8754) → 转发器(8755) → butler 容器。
# 用法: bash scripts/bridge-healthcheck.sh ；全部通过退出 0，任一 FAIL 退出 1。
set -uo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

env_value() {
  local key="$1"
  [[ -f .env ]] || return 0
  # Keep WSL runs compatible with `.env` files saved with Windows CRLF.
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); sub(/\r$/, ""); gsub(/^"|"$/, ""); print; exit }' .env
}

hermes_host_path="${BUTLER_HERMES_HOST_PATH:-$(env_value BUTLER_HERMES_HOST_PATH)}"
hermes_host_path="${hermes_host_path:-./.runtime/hermes}"
if [[ "$hermes_host_path" != /* ]]; then hermes_host_path="$ROOT_DIR/$hermes_host_path"; fi
TOKEN_FILE="$hermes_host_path/agent-butler/bridge.token"
BRIDGE_URL="${BUTLER_HERMES_BRIDGE_URL:-$(env_value BUTLER_HERMES_BRIDGE_URL)}"
BRIDGE_URL="${BRIDGE_URL:-}"
fails=0

pass() { echo "PASS  $1"; }
warn() { echo "WARN  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

# 1. token 可读且非空
if [[ -z "$BRIDGE_URL" ]]; then
  warn "BUTLER_HERMES_BRIDGE_URL 为空，跳过 Hermes 消息链路"
elif [[ -r "$TOKEN_FILE" && -s "$TOKEN_FILE" ]]; then
  pass "token 文件可读: $TOKEN_FILE"
else
  fail "token 文件不可读或为空: $TOKEN_FILE"
fi

# 2. 宿主 Bridge 健康接口（5 秒超时）
if [[ -z "$BRIDGE_URL" ]]; then
  :
elif command -v curl >/dev/null 2>&1 && [[ -r "$TOKEN_FILE" ]]; then
  TOKEN=$(cat "$TOKEN_FILE")
  bridge_health_url="$BRIDGE_URL"
  # 8755 is the host-side forwarder; its upstream Hermes Bridge listens on loopback :8754.
  if [[ "$BRIDGE_URL" == *":8755" ]]; then
    bridge_health_url="http://127.0.0.1:8754"
  fi
  body=$(curl -sS --max-time 5 -H "Authorization: Bearer $TOKEN" "${bridge_health_url%/}/v1/health" 2>/dev/null) || body=""
  # Parse the response through stdin so WSL/Windows Node environment handling
  # cannot truncate or reinterpret a JSON body assigned to an environment var.
  if [[ -n "$body" ]] && printf '%s' "$body" | python3 -c 'import json, sys; body = json.load(sys.stdin); raise SystemExit(0 if body.get("attached") is True and body.get("outboxWritable") is True else 1)' 2>/dev/null; then
    pass "bridge /v1/health attached + outboxWritable: $(echo "$body" | head -c 160)"
  else
    fail "bridge /v1/health 未通过（${bridge_health_url} 无监听、token 不匹配、未 attached 或 outbox 不可写）"
  fi
else
  warn "curl 不可用，跳过 bridge HTTP 检查"
fi

# 3. 转发器是否在监听 8755（Compose 或 systemd 二选一）
forwarder_ok=false
needs_forwarder=false
[[ "$BRIDGE_URL" == *":8755" ]] && needs_forwarder=true
if [[ "$needs_forwarder" != true ]]; then
  :
elif command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | grep -q ":8755 " \
    && { pass "转发器正在监听 :8755"; forwarder_ok=true; } \
    || fail "没有进程监听 :8755（转发器未运行，gateway 链路会断）"
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltn 2>/dev/null | grep -q ":8755 " \
    && { pass "转发器正在监听 :8755"; forwarder_ok=true; } \
    || fail "没有进程监听 :8755（转发器未运行，gateway 链路会断）"
else
  warn "ss/netstat 均不可用，跳过端口检查"
fi

# 4. 转发器归属状态
if [[ "$needs_forwarder" != true ]]; then
  :
elif command -v systemctl >/dev/null 2>&1; then
  state=$(systemctl --user is-active agent-butler-bridge-forward.service 2>/dev/null)
  if [[ "$state" == "active" ]]; then
    pass "agent-butler-bridge-forward.service: active"
  elif [[ "$forwarder_ok" == true ]]; then
    pass "8755 由非 systemd 转发器提供（允许 Compose profile）"
  else
    fail "没有可用的 8755 转发器（systemd 状态: ${state:-unknown}）"
  fi
else
  [[ "$forwarder_ok" == true ]] && pass "8755 转发器正在监听" || fail "没有可用的 8755 转发器"
fi

# 5. butler 容器运行情况
if command -v docker >/dev/null 2>&1; then
  containers=$(docker compose ps --format '{{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null || true)
  all_healthy=true
  for service in butler-gateway butler-watch butler-web; do
    row=$(printf '%s\n' "$containers" | awk -F '\t' -v service="$service" '$1 == service { print; exit }')
    state=$(printf '%s\n' "$row" | awk -F '\t' '{ print $2 }')
    health=$(printf '%s\n' "$row" | awk -F '\t' '{ print $3 }')
    if [[ "$state" != "running" || "$health" != "healthy" ]]; then
      fail "$service 状态异常: state=${state:-missing}, health=${health:-unknown}"
      all_healthy=false
    fi
  done
  if [[ "$all_healthy" == true ]]; then
    pass "gateway/watch/web 均为 running + healthy"
  fi
else
  warn "docker 不可用，跳过容器检查"
fi

# 6. 从 Gateway 容器实际访问配置的 Bridge URL，避免只测宿主监听端口。
if [[ -z "$BRIDGE_URL" ]]; then
  warn "BUTLER_HERMES_BRIDGE_URL 为空，消息数据面未启用"
elif command -v docker >/dev/null 2>&1 && [[ -r "$TOKEN_FILE" ]]; then
  if docker compose exec -T -e BRIDGE_URL="$BRIDGE_URL" butler-gateway node -e '
    const fs = require("node:fs");
    const token = fs.readFileSync("/home/butler/hermes/agent-butler/bridge.token", "utf8").trim();
    fetch(`${process.env.BRIDGE_URL}/v1/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      .then(async (r) => { const b = await r.json(); process.exit(r.ok && b.attached === true && b.outboxWritable === true ? 0 : 1); })
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    pass "Gateway 容器可通过 $BRIDGE_URL 访问 Bridge"
  else
    fail "Gateway 容器无法通过 $BRIDGE_URL 访问 Bridge"
  fi
else
  warn "无法执行容器内 Bridge 检查（docker/token 不可用）"
fi

# 7. Gateway 对外报告的消息连接状态。
#    配置了访问口令时 Gateway 的业务路由要求鉴权（/healthz 与 /internal/hermes 豁免），
#    这里从 .env 读取同一口令并作为 x-butler-token 携带。
if [[ -n "$BRIDGE_URL" ]] && command -v docker >/dev/null 2>&1; then
  ACCESS_TOKEN="$(env_value BUTLER_ACCESS_TOKEN)"
  if docker compose exec -T -e BUTLER_HEALTHCHECK_TOKEN="$ACCESS_TOKEN" butler-gateway node -e '
    const headers = process.env["BUTLER_HEALTHCHECK_TOKEN"]
      ? { "x-butler-token": process.env["BUTLER_HEALTHCHECK_TOKEN"] }
      : {};
    fetch("http://127.0.0.1:7532/api/messages/status", { headers, signal: AbortSignal.timeout(5000) })
      .then(async (r) => { const b = await r.json(); process.exit(r.ok && b.bridge?.connected === true && b.bridge?.attached === true ? 0 : 1); })
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    pass "Gateway message status: connected + attached"
  else
    fail "Gateway message status 未达到 connected + attached"
  fi
fi

echo "----"
echo "结果: $fails 个 FAIL"
[[ "$fails" -eq 0 ]] && exit 0 || exit 1
