#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
export VENICE_WEB_CONFIG_DIR="$HOME/.config/opencode/venice-web-B"
export VENICE_WEB_HOST=0.0.0.0
export VENICE_WEB_PORT=3463
IP=$(ip -4 addr show 2>/dev/null | grep -oE 'inet 192\.[0-9.]+' | head -1 | awk '{print $2}')
[ -z "$IP" ] && IP=$(ip -4 addr show 2>/dev/null | grep -oE 'inet 10\.[0-9.]+' | head -1 | awk '{print $2}')
[ -z "$IP" ] && IP="<telefon-ip>"
if pgrep -f 'src/proxy.mjs' >/dev/null; then pkill -f 'src/proxy.mjs'; sleep 2; fi
termux-wake-lock 2>/dev/null
echo "=== Venice Web (LAN) ==="
echo "Base URL : http://$IP:3463/v1"
echo "Local    : http://localhost:3463/v1"
echo "API Key  : venice-web"
echo "Profil   : $VENICE_WEB_CONFIG_DIR"
echo "Durdur   : pkill -f src/proxy.mjs"
echo "======================="
exec node src/proxy.mjs
