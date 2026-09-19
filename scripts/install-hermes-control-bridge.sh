#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# 优先采纳 Hermes 钉死的 Node 运行时（$HOME/.hermes/node/bin/node），
# 避免宿主 PATH 中非预期的 Node 版本污染；不存在时才 fallback 到宿主 node。
node_bin=""
if [[ -x "$HOME/.hermes/node/bin/node" ]]; then
  node_bin="$HOME/.hermes/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
fi
if [[ -z "$node_bin" ]]; then
  echo "ERROR: node is required to run the Hermes control bridge." >&2
  exit 1
fi

# 校验 Node 版本（必须 >= 22.5.0，以支持内置 node:sqlite 及现代 runtime 能力）
node_version="$("$node_bin" --version 2>/dev/null || echo "")"
node_version_clean="${node_version#v}"
node_major="$(echo "$node_version_clean" | cut -d. -f1)"
node_minor="$(echo "$node_version_clean" | cut -d. -f2)"

if [[ -z "$node_major" || ! "$node_major" =~ ^[0-9]+$ ]] || \
   [[ "$node_major" -lt 22 ]] || \
   [[ "$node_major" -eq 22 && "${node_minor:-0}" -lt 5 ]]; then
  echo "ERROR: Node.js >= 22.5.0 is required to run the Hermes control bridge." >&2
  echo "       Found: ${node_version:-unknown} at ${node_bin}" >&2
  echo "       Please update Node.js (e.g. in $HOME/.hermes/node/bin/node or your PATH) to >= 22.5.0." >&2
  exit 1
fi

mkdir -p "$HOME/.hermes/agent-butler"
token_file="$HOME/.hermes/agent-butler/control.token"
if [[ ! -s "$token_file" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$token_file"
  elif command -v "$node_bin" >/dev/null 2>&1; then
    "$node_bin" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$token_file"
  else
    echo "ERROR: openssl or node is required to generate the Hermes control token." >&2
    exit 1
  fi
  chmod 600 "$token_file"
fi

os_type="$(uname -s)"
if [[ "$os_type" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/ai.hermes.butler-control-bridge.plist"
  LABEL="ai.hermes.butler-control-bridge"
  UID_NUM="$(id -u)"
  mkdir -p "$PLIST_DIR" "$HOME/Library/Logs"
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${ROOT_DIR}/scripts/hermes-control-bridge.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BUTLER_HERMES_CONTROL_HOST</key><string>127.0.0.1</string>
    <key>BUTLER_HERMES_CONTROL_PORT</key><string>8756</string>
    <key>BUTLER_HERMES_CONTROL_TOKEN_FILE</key><string>${token_file}</string>
    <key>BUTLER_HERMES_CONTROL_ROOT</key><string>${HOME}/.hermes</string>
    <key>BUTLER_HERMES_CONTROL_TIMEOUT_MS</key><string>30000</string>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.hermes/node/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/butler-control-bridge.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/butler-control-bridge.err</string>
</dict>
</plist>
EOF
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$PLIST_FILE" >/dev/null
  fi
  # bootout 后 launchd 异步注销服务；需有界等待旧进程退出与 8756 端口释放，避免 EIO 与 EADDRINUSE
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! lsof -nP -iTCP:8756 -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  # 若超时仍有残留进程占用 8756，执行 TERM 兜底 KILL
  if lsof -nP -iTCP:8756 -sTCP:LISTEN >/dev/null 2>&1; then
    old_pids="$(lsof -nP -iTCP:8756 -sTCP:LISTEN -t 2>/dev/null || true)"
    for op in $old_pids; do
      kill -TERM "$op" 2>/dev/null || true
    done
    sleep 1
    if lsof -nP -iTCP:8756 -sTCP:LISTEN >/dev/null 2>&1; then
      old_pids="$(lsof -nP -iTCP:8756 -sTCP:LISTEN -t 2>/dev/null || true)"
      for op in $old_pids; do
        kill -KILL "$op" 2>/dev/null || true
      done
      sleep 0.5
    fi
  fi

  if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST_FILE" 2>/dev/null; then
    sleep 1
    launchctl bootstrap "gui/$UID_NUM" "$PLIST_FILE"
  fi
  launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

  if ! launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    echo "ERROR: failed to verify LaunchAgent status for $LABEL via launchctl print." >&2
    exit 1
  fi

  # 可证伪的运行判定：等待 8756 端口被新实例监听（最多 10 秒）
  listening=false
  for _ in $(seq 1 20); do
    if lsof -nP -iTCP:8756 -sTCP:LISTEN >/dev/null 2>&1; then
      listening=true
      break
    fi
    sleep 0.5
  done
  if [[ "$listening" != "true" ]]; then
    echo "ERROR: Hermes host control bridge failed to listen on port 8756 within 10s." >&2
    launchctl print "gui/$UID_NUM/$LABEL" >&2 || true
    exit 1
  fi

  echo "Hermes host control bridge installed and active (macOS LaunchAgent: $LABEL)."
  exit 0
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/agent-butler-hermes-control.service" <<EOF
[Unit]
Description=Agent Butler Hermes Host Control Bridge
After=hermes-gateway.service
[Service]
Type=simple
ExecStart=$node_bin $ROOT_DIR/scripts/hermes-control-bridge.mjs
Environment=BUTLER_HERMES_CONTROL_TOKEN_FILE=$token_file
Environment=BUTLER_HERMES_CONTROL_UNIT=hermes-gateway.service
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
# enable --now leaves an already-running process untouched when only the
# bridge script changed; restart explicitly so deploys load the new allowlist.
systemctl --user enable agent-butler-hermes-control.service
systemctl --user restart agent-butler-hermes-control.service
echo "Hermes host control bridge installed and active."
