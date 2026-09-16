#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" && -x "$HOME/.hermes/node/bin/node" ]]; then
  node_bin="$HOME/.hermes/node/bin/node"
fi
if [[ -z "$node_bin" ]]; then
  echo "ERROR: node is required to run the Hermes control bridge." >&2
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
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.hermes/node/bin:${PATH:-}</string>
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
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_FILE"
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
