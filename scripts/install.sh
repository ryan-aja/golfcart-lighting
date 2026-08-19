#!/usr/bin/env bash
#
# One-shot installer for the golf cart lighting controller on Raspberry Pi OS.
#
# Automates scripts/README.md steps 1-7. Safe to re-run: every step checks for
# the work already being done before repeating it.
#
#   curl -fsSL https://raw.githubusercontent.com/ryan-aja/golfcart-lighting/main/scripts/install.sh | bash
#
# or, from an existing clone:  ./scripts/install.sh
#
# The systemd unit and kiosk autostart in this repo hardcode the user `pi` and
# /home/pi. This script rewrites both to match whoever runs it, so a Pi imaged
# with a different username works without hand-editing anything.

set -euo pipefail

REPO_URL="https://github.com/ryan-aja/golfcart-lighting.git"

# When run from inside an existing clone, install in place rather than cloning
# a second copy elsewhere. Piped from curl there is no such directory, so fall
# back to the path the systemd unit and kiosk autostart expect.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || SELF_DIR=""
if [ -n "${SELF_DIR}" ] && [ -d "${SELF_DIR}/../.git" ]; then
  APP_DIR="$(cd "${SELF_DIR}/.." && pwd)"
else
  APP_DIR="${HOME}/golf-cart-lighting"
fi

BRANCH="main"
HOSTNAME_NEW="golfcart"
NODE_MAJOR=22

DO_NODE=1 DO_APP=1 DO_NETWORK=1 DO_SERVICE=1 DO_KIOSK=1 DO_HOSTNAME=1

usage() {
  cat <<EOF
Usage: $0 [options]

  --dir PATH         install location (default: ${APP_DIR})
  --branch NAME      branch to check out (default: ${BRANCH})
  --hostname NAME    mDNS hostname (default: ${HOSTNAME_NEW})
  --skip-node        assume a usable Node is already installed
  --skip-app         do not clone/build (service + kiosk config only)
  --skip-network     do not touch eth0 / NetworkManager
  --skip-service     do not install the systemd unit
  --skip-kiosk       headless install, no Chromium autostart
  --skip-hostname    leave the hostname alone
  -h, --help         this message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)            APP_DIR="$2"; shift 2 ;;
    --branch)         BRANCH="$2"; shift 2 ;;
    --hostname)       HOSTNAME_NEW="$2"; shift 2 ;;
    --skip-node)      DO_NODE=0; shift ;;
    --skip-app)       DO_APP=0; shift ;;
    --skip-network)   DO_NETWORK=0; shift ;;
    --skip-service)   DO_SERVICE=0; shift ;;
    --skip-kiosk)     DO_KIOSK=0; shift ;;
    --skip-hostname)  DO_HOSTNAME=0; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

RUN_USER="$(id -un)"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33m    warning: %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m    error: %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run as your normal user, not root — the kiosk autostart must land in a real user's home"
sudo -v || die "this user needs sudo access"

step "Preflight"
info "user:     ${RUN_USER}"
info "install:  ${APP_DIR}"
info "branch:   ${BRANCH}"

# ---------------------------------------------------------------- 1. Node ---
if [ "$DO_NODE" -eq 1 ]; then
  step "Node ${NODE_MAJOR}.x"
  current=""
  command -v node >/dev/null 2>&1 && current="$(node --version)"
  major="$(printf %s "${current#v}" | cut -d. -f1)"
  if [ -n "${major}" ] && [ "${major}" -ge "${NODE_MAJOR}" ] 2>/dev/null; then
    info "already ${current}, skipping"
  else
    info "installing from NodeSource (found: ${current:-none})"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
    info "now $(node --version)"
  fi
fi

# ---------------------------------------------------- 2. Clone and build ---
if [ "$DO_APP" -eq 1 ]; then
  step "Application"
  if [ -d "${APP_DIR}/.git" ]; then
    info "updating existing clone"
    git -C "${APP_DIR}" fetch origin "${BRANCH}"
    git -C "${APP_DIR}" checkout "${BRANCH}"
    git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
  else
    [ -e "${APP_DIR}" ] && die "${APP_DIR} exists but is not a git clone"
    command -v git >/dev/null 2>&1 || sudo apt-get install -y git
    git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
  fi

  cd "${APP_DIR}"
  info "npm install"
  npm install
  info "npm run build"
  npm run build
  info "npm test"
  npm test
fi

# ------------------------------------------ 3. Static ethernet to BC-204 ---
if [ "$DO_NETWORK" -eq 1 ]; then
  step "Static eth0 -> BC-204 (192.168.10.10/24)"
  if ! command -v nmcli >/dev/null 2>&1; then
    warn "nmcli not found — not NetworkManager-based, configure eth0 by hand"
  elif nmcli -t -f NAME connection show | grep -qx "bc204"; then
    info "connection 'bc204' already exists, skipping"
  else
    # Deliberately no gateway and no DNS: point-to-point cable to the
    # lighting controller. Wi-Fi must stay the default route.
    sudo nmcli connection add type ethernet ifname eth0 con-name bc204 \
      ipv4.method manual \
      ipv4.addresses 192.168.10.10/24 \
      ipv6.method disabled \
      connection.autoconnect yes
    sudo nmcli connection up bc204 || warn "could not bring up bc204 — is the cable connected?"
  fi
  if ping -c 2 -W 2 192.168.10.20 >/dev/null 2>&1; then
    info "BC-204 responds at 192.168.10.20"
  else
    warn "no reply from 192.168.10.20 — set the BC-204 to 192.168.10.20/24 in its own web UI"
  fi
fi

# ------------------------------------------------------ 4. systemd unit ---
if [ "$DO_SERVICE" -eq 1 ]; then
  step "systemd service"
  src="${APP_DIR}/scripts/golfcart-lighting.service"
  [ -f "$src" ] || die "missing ${src}"
  tmp="$(mktemp)"
  # Retarget the unit at this user and install path.
  sed -e "s|^User=pi$|User=${RUN_USER}|" \
      -e "s|/home/pi/golf-cart-lighting|${APP_DIR}|g" \
      -e "s|^ExecStart=/usr/bin/node|ExecStart=$(command -v node)|" \
      "$src" > "$tmp"
  sudo install -m 0644 "$tmp" /etc/systemd/system/golfcart-lighting.service
  rm -f "$tmp"
  info "User=${RUN_USER}, WorkingDirectory=${APP_DIR}"
  sudo systemctl daemon-reload
  sudo systemctl enable --now golfcart-lighting
  sleep 2
  if systemctl is-active --quiet golfcart-lighting; then
    info "service is running"
  else
    warn "service did not start — journalctl -u golfcart-lighting -n 50"
  fi
fi

# ----------------------------------------------------- 5. Chromium kiosk ---
if [ "$DO_KIOSK" -eq 1 ]; then
  step "Chromium kiosk"
  sudo apt-get install -y chromium-browser unclutter || \
    sudo apt-get install -y chromium unclutter
  chmod +x "${APP_DIR}/scripts/start-kiosk.sh"
  mkdir -p "${HOME}/.config/autostart"
  sed "s|/home/pi/golf-cart-lighting|${APP_DIR}|g" \
    "${APP_DIR}/scripts/kiosk.desktop" > "${HOME}/.config/autostart/kiosk.desktop"
  info "autostart written to ~/.config/autostart/kiosk.desktop"
fi

# ------------------------------------------------- 6. Hostname / mDNS ---
if [ "$DO_HOSTNAME" -eq 1 ]; then
  step "Hostname and mDNS"
  sudo apt-get install -y avahi-daemon
  if [ "$(hostnamectl --static)" = "${HOSTNAME_NEW}" ]; then
    info "hostname already ${HOSTNAME_NEW}"
  else
    sudo hostnamectl set-hostname "${HOSTNAME_NEW}"
    info "hostname set to ${HOSTNAME_NEW} (takes effect fully after reboot)"
  fi
fi

step "Done"
port="$(grep -o '"httpPort"[[:space:]]*:[[:space:]]*[0-9]*' "${APP_DIR}/config/network.json" | grep -o '[0-9]*$' || echo 3100)"
cat <<EOF

    Local:   http://localhost:${port}
    Network: http://${HOSTNAME_NEW}.local:${port}

    systemctl status golfcart-lighting
    journalctl -u golfcart-lighting -f

    Art-Net output is live (LIGHTING_SIMULATION=false in the unit).
    Reboot to bring up the touchscreen kiosk.
EOF
