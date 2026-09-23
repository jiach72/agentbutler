#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

# 端口监听探测（与 bridge-healthcheck.sh 共用同一份平台感知实现）：
# Linux 用 ss/netstat，Darwin 用 lsof，都没有才视为「无监听」。
if [[ -f "$ROOT_DIR/scripts/lib/port-probe.sh" ]]; then
  # shellcheck source=scripts/lib/port-probe.sh
  . "$ROOT_DIR/scripts/lib/port-probe.sh"
fi

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

internal_token="${BUTLER_INTERNAL_TOKEN:-$(env_value BUTLER_INTERNAL_TOKEN)}"
if [[ -z "$internal_token" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    internal_token=$(openssl rand -hex 32)
  elif command -v node >/dev/null 2>&1; then
    internal_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  elif command -v python3 >/dev/null 2>&1; then
    internal_token=$(python3 -c 'import secrets;print(secrets.token_hex(32))')
  fi
  if [[ -n "$internal_token" ]]; then
    if grep -qE '^BUTLER_INTERNAL_TOKEN=' .env; then
      env_tmp="$(mktemp .env.XXXXXX)"
      awk -v value="$internal_token" 'BEGIN { done = 0 } /^BUTLER_INTERNAL_TOKEN=/ { print "BUTLER_INTERNAL_TOKEN=" value; done = 1; next } { print } END { if (!done) print "BUTLER_INTERNAL_TOKEN=" value }' .env > "$env_tmp"
      mv "$env_tmp" .env
    else
      printf '\nBUTLER_INTERNAL_TOKEN=%s\n' "$internal_token" >> .env
    fi
    echo "Generated and stored BUTLER_INTERNAL_TOKEN in .env."
  fi
fi
export BUTLER_INTERNAL_TOKEN="$internal_token"

compose_args=()
bridge_url="${BUTLER_HERMES_BRIDGE_URL:-$(env_value BUTLER_HERMES_BRIDGE_URL)}"
if [[ "$bridge_url" == *":8755" ]]; then
  # Prefer an already-running systemd forwarder; otherwise let Compose own it.
  if command -v systemctl >/dev/null 2>&1 &&
     [[ "$(systemctl --user is-active agent-butler-bridge-forward.service 2>/dev/null || true)" == "active" ]]; then
    echo "Using existing systemd bridge forwarder on :8755."
  elif probe_port_listening 8755; then
    echo "Using an existing listener on :8755; Compose bridge-forward profile is skipped."
  else
    compose_args+=(--profile bridge-forward)
  fi
fi

# hindsight 记忆探针经宿主 loopback 转发（9178 → 127.0.0.1:${BUTLER_HINDSIGHT_PORT:-9177}）；
# 配置了探针地址且 9178 尚无监听时由 Compose 托管该 profile。
hindsight_url="${BUTLER_HINDSIGHT_BASE_URL:-$(env_value BUTLER_HINDSIGHT_BASE_URL)}"
if [[ -n "$hindsight_url" ]]; then
  if probe_port_listening 9178; then
    echo "Using an existing listener on :9178; Compose hindsight-forward profile is skipped."
  else
    compose_args+=(--profile hindsight-forward)
  fi
fi

# 本地知识库 (AnythingLLM RAG) 服务按需拉起：
# 若偏好设置中已开启、或 .env / 环境变量中配置了启用，自动装配 rag-anythingllm profile。
anythingllm_enabled="${BUTLER_ANYTHINGLLM_ENABLED:-$(env_value BUTLER_ANYTHINGLLM_ENABLED)}"
compose_profiles="${COMPOSE_PROFILES:-$(env_value COMPOSE_PROFILES)}"
if [[ "$anythingllm_enabled" == "true" ]] || \
   [[ "$compose_profiles" == *"rag-anythingllm"* ]] || \
   grep -q '"enabled":true' "$ROOT_DIR/data/knowledge_prefs.json" 2>/dev/null || \
   docker volume inspect agent-butler-data >/dev/null 2>&1 && docker run --rm -v agent-butler-data:/data:ro alpine grep -q '"enabled":true' /data/data/knowledge_prefs.json 2>/dev/null; then
  echo "Enabling local knowledge base (AnythingLLM RAG) profile."
  compose_args+=(--profile rag-anythingllm)
fi

# macOS 自带的 bash 3.2 在 set -u 下展开空数组（"${compose_args[@]}"）会报
# unbound variable；`${arr[@]+"${arr[@]}"}` 写法在数组为空时整体省略该参数，
# 非空时逐元素展开，两种 bash 语义下都与 Linux 行为一致。
compose() { docker compose ${compose_args[@]+"${compose_args[@]}"} "$@"; }

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
deploy_sha="$(git rev-parse HEAD 2>/dev/null || true)"
export BUTLER_GIT_COMMIT="$deploy_sha"
if [[ -n "$deploy_sha" ]]; then
  env_set BUTLER_GIT_COMMIT "$deploy_sha"
fi

host_os="$(uname -s 2>/dev/null || echo "Linux")"
host_arch="$(uname -m 2>/dev/null || echo "x86_64")"
export BUTLER_HOST_OS="$host_os"
export BUTLER_HOST_ARCH="$host_arch"
env_set BUTLER_HOST_OS "$host_os"
env_set BUTLER_HOST_ARCH "$host_arch"

# 宿主客观物理硬件探测（内存、核心、型号），供容器内 Ollama 自适应推荐引擎精准评估
host_mem_gb=""
host_cores=""
host_logical_cores=""
host_cpu_model=""

if [[ "$host_os" == "Darwin" ]]; then
  hw_memsize="$(sysctl -n hw.memsize 2>/dev/null || true)"
  if [[ -n "$hw_memsize" && "$hw_memsize" =~ ^[0-9]+$ ]]; then
    host_mem_gb="$(awk -v b="$hw_memsize" 'BEGIN {printf "%.1f", b / 1073741824}')"
  fi
  host_cores="$(sysctl -n hw.physicalcpu 2>/dev/null || true)"
  host_logical_cores="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
  host_cpu_model="$(sysctl -n machdep.cpu.brand_string 2>/dev/null | tr -d '"\r\n' || true)"
elif [[ "$host_os" == "Linux" ]]; then
  # WSL2 探测：若存在 powershell.exe，优先读取 Windows 宿主真实硬件指标
  is_wsl=0
  if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
    is_wsl=1
  fi

  if [[ "$is_wsl" -eq 1 ]] && command -v powershell.exe >/dev/null 2>&1; then
    wsl_ps_out="$(powershell.exe -NoProfile -NonInteractive -Command '
      try {
        $cs = Get-CimInstance Win32_ComputerSystem;
        $proc = Get-CimInstance Win32_Processor | Select-Object -First 1;
        $all = Get-CimInstance Win32_Processor;
        $cores = ($all | Measure-Object -Property NumberOfCores -Sum).Sum;
        $logicals = ($all | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum;
        $mem = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1);
        "$mem|$cores|$logicals|$($proc.Name.Trim())"
      } catch {}
    ' 2>/dev/null | tr -d '\r\n' || true)"

    if [[ "$wsl_ps_out" == *"|"* ]]; then
      IFS='|' read -r ps_mem ps_cores ps_logicals ps_cpu <<< "$wsl_ps_out"
      [[ -n "$ps_mem" ]] && host_mem_gb="$ps_mem"
      [[ -n "$ps_cores" ]] && host_cores="$ps_cores"
      [[ -n "$ps_logicals" ]] && host_logical_cores="$ps_logicals"
      [[ -n "$ps_cpu" ]] && host_cpu_model="$(echo "$ps_cpu" | tr -d '"\r\n')"
    fi
  fi

  # Linux 裸机或 VM 常规探测（WSL 未取到时平滑回退）
  if [[ -z "$host_mem_gb" && -f /proc/meminfo ]]; then
    host_mem_gb="$(awk '/MemTotal/ {printf "%.1f", $2 / 1048576}' /proc/meminfo 2>/dev/null || true)"
  fi
  if [[ -z "$host_cores" ]]; then
    if command -v lscpu >/dev/null 2>&1; then
      host_cores="$(lscpu -p=CORE 2>/dev/null | grep -v '^#' | sort -u | wc -l || true)"
    fi
    if [[ -z "$host_cores" || "$host_cores" -eq 0 ]] && [[ -f /proc/cpuinfo ]]; then
      host_cores="$(grep -m1 '^cpu cores' /proc/cpuinfo 2>/dev/null | awk '{print $NF}' || true)"
    fi
  fi
  if [[ -z "$host_logical_cores" ]]; then
    if command -v nproc >/dev/null 2>&1; then
      host_logical_cores="$(nproc 2>/dev/null || true)"
    elif [[ -f /proc/cpuinfo ]]; then
      host_logical_cores="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$host_cpu_model" ]]; then
    if [[ -f /proc/cpuinfo ]]; then
      host_cpu_model="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr -d '"\r\n' || true)"
    fi
    if [[ -z "$host_cpu_model" ]] && command -v lscpu >/dev/null 2>&1; then
      host_cpu_model="$(lscpu 2>/dev/null | grep -m1 'Model name:' | cut -d: -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr -d '"\r\n' || true)"
    fi
  fi
fi

if [[ -n "$host_mem_gb" ]]; then
  export BUTLER_HOST_MEM_GB="$host_mem_gb"
  env_set BUTLER_HOST_MEM_GB "$host_mem_gb"
fi
if [[ -n "$host_cores" ]]; then
  export BUTLER_HOST_CORES="$host_cores"
  env_set BUTLER_HOST_CORES "$host_cores"
fi
if [[ -n "$host_logical_cores" ]]; then
  export BUTLER_HOST_LOGICAL_CORES="$host_logical_cores"
  env_set BUTLER_HOST_LOGICAL_CORES "$host_logical_cores"
fi
if [[ -n "$host_cpu_model" ]]; then
  export BUTLER_HOST_CPU_MODEL="$host_cpu_model"
  env_set BUTLER_HOST_CPU_MODEL "$host_cpu_model"
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
latest_backup="none"
if [[ "$hermes_host_path" == "$HOME/.hermes" ]]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user cat hermes-gateway.service >/dev/null 2>&1; then
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
  elif [[ "$(uname -s)" == "Darwin" && -d "$hermes_host_path/hermes-agent" ]]; then
    bash scripts/install-hermes-control-bridge.sh
    if [[ -z "$control_url" ]]; then
      control_url="http://host.docker.internal:8756"
      env_set BUTLER_HERMES_CONTROL_URL "$control_url"
    fi
    if [[ -z "$(env_value BUTLER_HERMES_CONTROL_TOKEN_FILE)" ]]; then
      env_set BUTLER_HERMES_CONTROL_TOKEN_FILE "$control_token_container"
    fi
    export BUTLER_HERMES_CONTROL_URL="$control_url"
    export BUTLER_HERMES_CONTROL_TOKEN_FILE="$control_token_container"
    echo "Hermes macOS 宿主控制桥已安装；Watch 将通过受限白名单接口执行一键修复。"
  fi
fi
if [[ "$control_url" == *":8757" ]]; then
  compose_args+=(--profile hermes-control-forward)
fi

if [[ -n "$bridge_url" && ! -s "$hermes_host_path/agent-butler/bridge.token" ]]; then
  echo "ERROR: BUTLER_HERMES_BRIDGE_URL is configured but token is missing: $hermes_host_path/agent-butler/bridge.token" >&2
  echo "       Set BUTLER_HERMES_HOST_PATH to the Linux Hermes state directory." >&2
  echo "DEPLOY_RESULT=failed step=preflight_token" >&2
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
    latest_backup="backups/$backup_name"
    echo "Backup OK: $latest_backup"
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
      host_bridge_py=""
      for cand in "${hermes_host_path}/hermes-agent/gateway/butler_bridge/server.py" "${hermes_host_path}/../hermes-agent/gateway/butler_bridge/server.py" "${HOME:-}/.hermes/hermes-agent/gateway/butler_bridge/server.py"; do
        if [[ -f "$cand" ]]; then host_bridge_py="$cand"; break; fi
      done
      if [[ -n "$host_bridge_py" ]]; then
        if ! grep -q "resolve_unknown" "$host_bridge_py" 2>/dev/null; then
          echo "WARNING: 宿主 Hermes Bridge 副本缺少 resolve 权威结案端点。" >&2
          echo "         建议同步更新：python -m agent_butler_bridge.installer update <hermes-agent-path> 并重启网关" >&2
        fi
      fi
    fi
    deploy_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
    echo "DEPLOY_RESULT=ok sha=$deploy_sha backup=$latest_backup"
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
deploy_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
echo "DEPLOY_RESULT=failed step=healthcheck sha=$deploy_sha backup=$latest_backup" >&2
exit 1
