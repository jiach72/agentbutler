#!/usr/bin/env bash
# Agent Butler 一键安装脚本：前置检查 → 配置初始化 → Docker 部署 → 健康验证。
# 用法：bash install.sh
# 适合首次部署；已部署环境请使用 scripts/deploy.sh 或面板内一键升级。
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo "═══ Agent Butler 安装向导 ═══"
echo ""

# ── 前置检查 ──
echo "── 前置检查 ──"

command -v git >/dev/null 2>&1 || fail "未找到 git，请先安装：https://git-scm.com"
ok "git $(git --version | awk '{print $3}')"

if ! command -v docker >/dev/null 2>&1; then
  fail "未找到 docker。请安装 Docker 20.10+（含 Compose v2）后重试。"
fi
DOCKER_VER=$(docker --version | grep -oP '\d+\.\d+' | head -1)
ok "docker $DOCKER_VER"

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose v2 不可用。请确认 Docker 版本 ≥ 20.10 且启用了 Compose v2 插件。"
fi
ok "docker compose v2"

if [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  ok "WSL2 环境检测到"
  if [ -d /mnt/c ] && [ "$(pwd | grep -c '^/mnt/c')" -gt 0 ]; then
    fail "当前目录在 /mnt/c 下（NTFS 挂载）。请将仓库克隆到 WSL ext4 内（如 ~/agentbutler）后重试。"
  fi
fi

if command -v python3 >/dev/null 2>&1; then
  PY_VER=$(python3 --version | awk '{print $2}')
  ok "python3 $PY_VER"
else
  warn "未找到 python3 —— 启用 Hermes 消息接入时需要 Python 3.11+"
fi

# ── 配置 ──
echo ""
echo "── 配置 ──"

if [ ! -f .env ]; then
  cp .env.example .env
  ok "已从 .env.example 创建 .env"
  warn "请编辑 .env 设置 BUTLER_HERMES_HOST_PATH 等关键路径，然后重新运行本脚本。"
  echo ""
  echo "快速配置："
  echo "  nano .env"
  echo ""
  echo "关键项："
  echo "  BUTLER_FRAMEWORK=hermes          # 被管框架"
  echo "  BUTLER_HERMES_HOST_PATH=...      # Hermes 安装目录"
  echo "  # BUTLER_ACCESS_TOKEN=...        # 跨设备访问时设置"
  exit 0
else
  ok ".env 已存在，跳过配置初始化"
fi

# ── 部署 ──
echo ""
echo "── 部署 ──"
bash scripts/deploy.sh

# ── 验证 ──
echo ""
echo "── 验证 ──"
HEALTH=$(curl -s -m 10 http://127.0.0.1:7531/api/health 2>/dev/null || echo '{"ok":false}')
OK=$(echo "$HEALTH" | grep -o '"ok":true' || echo "")
if [ -n "$OK" ]; then
  ok "面板已就绪：http://127.0.0.1:7531"
else
  warn "面板健康检查未通过，请检查 docker compose logs"
fi

BRIDGE=$(bash scripts/bridge-healthcheck.sh 2>&1 | tail -1 || echo "跳过（未启用 Hermes）")
if echo "$BRIDGE" | grep -q "0 个 FAIL"; then
  ok "Hermes Bridge 链路正常"
else
  warn "Hermes Bridge: $BRIDGE"
fi

echo ""
echo "═══ 安装完成 ═══"
echo ""
echo "  打开面板：http://127.0.0.1:7531"
echo "  跨设备访问：设置 BUTLER_ACCESS_TOKEN 后用 http://<本机IP>:7531"
echo ""
