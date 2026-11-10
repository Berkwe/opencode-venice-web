#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
export VENICE_WEB_CONFIG_DIR="$HOME/.config/opencode/venice-web-B"
export VENICE_WEB_HOST=127.0.0.1
export VENICE_WEB_PORT=3462
if pgrep -f 'src/proxy.mjs' >/dev/null; then pkill -f 'src/proxy.mjs'; sleep 2; fi
termux-wake-lock 2>/dev/null
echo "=== Venice Web (LOCAL) ==="
echo "Base URL : http://localhost:3462/v1"
echo "API Key  : venice-web"
echo "Profil   : $VENICE_WEB_CONFIG_DIR"
echo "Durdur   : pkill -f src/proxy.mjs"
echo "========================="
exec node src/proxy.mjs
