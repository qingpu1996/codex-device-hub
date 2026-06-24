#!/bin/bash
set -euo pipefail

LABEL="com.qingpu.codex-quota-dashboard"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CODEX_BIN="$(command -v codex)"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
UID_VALUE="$(id -u)"
HOME_DIR="$HOME"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME_DIR/Library/Logs/CodexQuotaDashboard"
STDOUT_LOG="$LOG_DIR/stdout.log"
STDERR_LOG="$LOG_DIR/stderr.log"
PATH_FOR_LAUNCHD="$(dirname "$CODEX_BIN"):$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DEFAULT_INTERFACE="$(route -n get default | awk '/interface:/{print $2; exit}')"
if [ -z "$DEFAULT_INTERFACE" ]; then
  echo "Could not detect default network interface" >&2
  exit 1
fi

LAN_IP="$(ipconfig getifaddr "$DEFAULT_INTERFACE")"
if [ -z "$LAN_IP" ]; then
  echo "Default interface $DEFAULT_INTERFACE has no LAN IPv4 address" >&2
  exit 1
fi

MAC_ADDRESS="$(ifconfig "$DEFAULT_INTERFACE" | awk '/ether/{print $2; exit}')"
if [ -z "$MAC_ADDRESS" ]; then
  echo "Could not detect MAC address for $DEFAULT_INTERFACE" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
touch "$STDOUT_LOG" "$STDERR_LOG"

cd "$PROJECT_DIR"
"$NPM_BIN" install
"$NPM_BIN" run build

"$NODE_BIN" "$PROJECT_DIR/dist/src/cli.js" ensure-config \
  --bind-host "$LAN_IP" \
  --port "19527" \
  --codex-path "$CODEX_BIN" \
  --node-path "$NODE_BIN" \
  --project-dir "$PROJECT_DIR" \
  --network-interface "$DEFAULT_INTERFACE" \
  --interface-mac "$MAC_ADDRESS"

"$NODE_BIN" "$PROJECT_DIR/dist/src/cli.js" write-plist \
  --plist "$PLIST" \
  --node "$NODE_BIN" \
  --entry "$PROJECT_DIR/dist/src/server.js" \
  --project "$PROJECT_DIR" \
  --home "$HOME_DIR" \
  --path "$PATH_FOR_LAUNCHD" \
  --stdout "$STDOUT_LOG" \
  --stderr "$STDERR_LOG"

launchctl bootout "gui/$UID_VALUE" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

echo "Waiting for health check..."
for _ in $(seq 1 30); do
  if "$NODE_BIN" "$PROJECT_DIR/dist/src/cli.js" healthcheck >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

"$NODE_BIN" "$PROJECT_DIR/dist/src/cli.js" healthcheck

FINAL_URL="$("$NODE_BIN" "$PROJECT_DIR/dist/src/cli.js" print-device-url)"

echo
echo "Installed $LABEL"
echo "Project: $PROJECT_DIR"
echo "Codex: $CODEX_BIN"
echo "Node: $NODE_BIN"
echo "Interface: $DEFAULT_INTERFACE"
echo "IPv4: $LAN_IP"
echo "MAC: $MAC_ADDRESS"
echo "Device API URL: $FINAL_URL"
echo "Logs: $STDOUT_LOG"
echo "Logs: $STDERR_LOG"
echo
echo "Please reserve IPv4 $LAN_IP for MAC $MAC_ADDRESS in your router DHCP settings."
echo "If macOS Firewall prompts for Node inbound connections, click Allow for LAN access."
