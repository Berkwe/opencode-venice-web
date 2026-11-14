#!/bin/sh
# Venice Web - local (127.0.0.1) launcher.
#
# Works in Termux and in a plain Linux shell: no termux-* command is required.
# Profile: $VENICE_WEB_CONFIG_DIR, else the shared default from src/lib/config.mjs.
cd "$(dirname "$0")" || exit 1

PORT="${VENICE_WEB_PORT:-3462}"
export VENICE_WEB_HOST=127.0.0.1
export VENICE_WEB_PORT="$PORT"

if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock 2>/dev/null; fi
if pgrep -f 'src/proxy.mjs' >/dev/null 2>&1; then pkill -f 'src/proxy.mjs'; sleep 2; fi

echo "=== Venice Web (LOCAL) ==="
echo "Base URL : http://localhost:$PORT/v1"
echo "API Key  : venice-web"
echo "Profil   : ${VENICE_WEB_CONFIG_DIR:-$HOME/.config/opencode/venice-web}"
echo "Durdur   : pkill -f src/proxy.mjs"
echo "========================="
exec node src/proxy.mjs
