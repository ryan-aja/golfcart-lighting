#!/usr/bin/env bash
#
# Actions behind the desktop icons and keyboard shortcuts.
#
# One dispatcher rather than four scripts, so the .desktop files stay trivial
# and there is a single place to fix behaviour. Anything that produces output a
# human needs to read opens its own terminal and waits at the end — a desktop
# launcher that flashes a window and vanishes tells you nothing.
#
#   desktop-actions.sh kiosk    relaunch the touchscreen UI
#   desktop-actions.sh restart  restart the lighting service
#   desktop-actions.sh doctor   run the Art-Net diagnostic
#   desktop-actions.sh logs     follow the service log
#   desktop-actions.sh status   one-screen health summary

set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="$(grep -o '"httpPort"[[:space:]]*:[[:space:]]*[0-9]*' "${APP_DIR}/config/network.json" 2>/dev/null \
  | grep -o '[0-9]*$' || echo 3100)"

# The kiosk covers the screen, so anything interactive needs its own window.
TERM_EMU="$(command -v lxterminal || command -v x-terminal-emulator || command -v xterm || true)"

run_in_terminal() {
  # Re-exec this script inside a terminal, with a pause so output can be read.
  if [ -n "${TERM_EMU}" ] && [ -z "${GOLFCART_IN_TERM:-}" ]; then
    GOLFCART_IN_TERM=1 exec "${TERM_EMU}" -e bash -c \
      "GOLFCART_IN_TERM=1 '${BASH_SOURCE[0]}' $1; echo; read -rp 'Press Enter to close…'"
  fi
}

case "${1:-}" in
  kiosk)
    # start-kiosk.sh holds an flock, so double-clicking twice is harmless.
    exec "${APP_DIR}/scripts/start-kiosk.sh"
    ;;

  restart)
    run_in_terminal restart
    echo "Restarting the lighting service…"
    sudo systemctl restart golfcart-lighting
    for _ in $(seq 1 20); do
      curl -fsS -o /dev/null "http://localhost:${PORT}/healthz" 2>/dev/null && break
      sleep 1
    done
    systemctl --no-pager --lines=0 status golfcart-lighting | head -5
    ;;

  doctor)
    run_in_terminal doctor
    cd "${APP_DIR}" || exit 1
    node scripts/artnet-doctor.mjs --iface eth0
    ;;

  logs)
    run_in_terminal logs
    journalctl -u golfcart-lighting -f -n 60
    ;;

  status)
    run_in_terminal status
    echo "=== Lighting controller ==="
    echo "service : $(systemctl is-active golfcart-lighting)"
    echo "web UI  : http://localhost:${PORT}   http://$(hostname).local:${PORT}"
    echo "health  : $(curl -fsS -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/healthz" 2>/dev/null || echo unreachable)"
    echo "kiosk   : $(pgrep -fc -- '--kiosk' 2>/dev/null || echo 0) running"
    echo
    echo "=== Network ==="
    echo "wifi    : $(hostname -I)"
    echo "eth0    : $(ip -br addr show eth0 2>/dev/null | awk '{print $3}')  carrier=$(cat /sys/class/net/eth0/carrier 2>/dev/null || echo ?)"
    printf 'BC-204  : '
    if ping -c1 -W2 192.168.10.20 >/dev/null 2>&1; then echo 'reachable'; else echo 'NO REPLY'; fi
    echo
    echo "=== Art-Net ==="
    curl -fsS "http://localhost:${PORT}/api/status" 2>/dev/null \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d).artnet;
          console.log('universes :',JSON.stringify(a.universes));
          console.log('frames    :',a.framesSent);
          console.log('errors    :',a.errorCount,a.lastError?('('+a.lastError+')'):'');
        }catch{console.log('(service not responding)')}})"
    ;;

  *)
    echo "usage: $(basename "$0") {kiosk|restart|doctor|logs|status}" >&2
    exit 1
    ;;
esac
