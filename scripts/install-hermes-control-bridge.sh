#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "ERROR: node is required to run the Hermes control bridge." >&2
  exit 1
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR" "$HOME/.hermes/agent-butler"
token_file="$HOME/.hermes/agent-butler/control.token"
if [[ ! -s "$token_file" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$token_file"
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$token_file"
  else
    echo "ERROR: openssl or node is required to generate the Hermes control token." >&2
    exit 1
  fi
  chmod 600 "$token_file"
fi
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
