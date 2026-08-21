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
NODE_MIN="20.11.0"     # package.json engines
NODE_MAJOR=22          # only used for the NodeSource fallback

DO_NODE=1 DO_APP=1 DO_NETWORK=1 DO_SERVICE=1 DO_KIOSK=1 DO_HOSTNAME=1 DO_AUDIO=1

usage() {
  cat <<EOF
Usage: $0 [options]

  --dir PATH         install location (default: ${APP_DIR})
  --branch NAME      branch to check out (default: ${BRANCH})
  --hostname NAME    mDNS hostname (default: ${HOSTNAME_NEW})
  --skip-node        assume a usable Node is already installed
  --skip-app         do not clone/build (service + kiosk config only)
  --skip-audio       do not install an audio player or build the theme
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
    --skip-audio)     DO_AUDIO=0; shift ;;
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

# `sudo -v` cannot be used as the check: it validates credentials with no
# command to match, so it demands a password even where NOPASSWD grants
# everything — which fails an otherwise fine unattended run over SSH. Probe
# with a real command instead, and only prompt when there is a tty to type at.
if sudo -n true 2>/dev/null; then
  :
elif [ -t 0 ]; then
  sudo -v || die "this user needs sudo access"
else
  die "sudo needs a password and there is no terminal to enter it — run this from a session on the Pi, or grant NOPASSWD"
fi

step "Preflight"
info "user:     ${RUN_USER}"
info "install:  ${APP_DIR}"
info "branch:   ${BRANCH}"

# ---------------------------------------------------------------- 1. Node ---
# package.json requires >=20.11. Prefer the distro package: Raspberry Pi OS
# Trixie ships Node 20.19, which is new enough, and NodeSource publishes no
# trixie suite at all. Only fall back to NodeSource when apt cannot satisfy it.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(printf '%s\n%s\n' "${NODE_MIN}" "$(node --version | tr -d v)" \
      | sort -V | head -1)" = "${NODE_MIN}" ]
}

if [ "$DO_NODE" -eq 1 ]; then
  step "Node (need >= ${NODE_MIN})"
  if node_ok; then
    info "already $(node --version), skipping"
  else
    info "found: $(command -v node >/dev/null 2>&1 && node --version || echo none)"
    cand="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}')"
    info "apt candidate: ${cand:-none}"
    sudo apt-get update -qq
    sudo apt-get install -y nodejs npm
    if node_ok; then
      info "installed $(node --version) from apt"
    else
      . /etc/os-release
      info "apt version too old, trying NodeSource for ${VERSION_CODENAME}"
      if curl -fsI "https://deb.nodesource.com/node_${NODE_MAJOR}.x/dists/${VERSION_CODENAME}/Release" >/dev/null 2>&1; then
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
      else
        die "no Node >= ${NODE_MIN} available: apt has ${cand:-none} and NodeSource has no ${VERSION_CODENAME} suite"
      fi
    fi
  fi
  command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm
  info "node $(node --version), npm $(npm --version)"
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

# ------------------------------------------------- 2b. Theme audio ---
# The THEME button plays a file through the Pi's own audio output, so the Pi
# needs a command-line player. mpg123 covers mp3; alsa-utils brings aplay for
# wav plus alsamixer for setting the level.
if [ "$DO_AUDIO" -eq 1 ]; then
  step "Theme audio"
  if ! sudo apt-get install -y mpg123 alsa-utils; then
    warn "no audio player installed - the THEME button will stay disabled"
  fi

  # No audio is committed to the repo: a commercial recording could not be
  # redistributed there. Generate the original fallback track unless the
  # operator has already dropped their own file in.
  if [ -f "${APP_DIR}/assets/audio/theme.mp3" ]; then
    info "using your assets/audio/theme.mp3"
  elif [ -f "${APP_DIR}/assets/audio/theme.wav" ]; then
    info "theme.wav already present"
  else
    if ! (cd "${APP_DIR}" && npm run --silent make-theme); then
      warn "could not generate the theme - run 'npm run make-theme' by hand"
    fi
  fi

  # HDMI is the default sink on a fresh image, which is silent on a cart with
  # a jack-connected speaker. Only a warning: some carts do use HDMI audio.
  if command -v aplay >/dev/null 2>&1; then
    info "audio devices: $(aplay -l 2>/dev/null | grep -c '^card ' || echo 0) card(s)"
    info "if you hear nothing, set the output with: sudo raspi-config (System Options > Audio)"
  fi
fi

# ------------------------------------------ 3. Static ethernet to BC-204 ---
if [ "$DO_NETWORK" -eq 1 ]; then
  step "Static eth0 -> BC-204 (192.168.10.10/24)"
  if ! command -v nmcli >/dev/null 2>&1; then
    warn "nmcli not found — not NetworkManager-based, configure eth0 by hand"
  elif nmcli -t -f NAME connection show | grep -qx "bc204"; then
    info "connection 'bc204' already exists"
    # Older runs of this installer created the profile without the timeout.
    sudo nmcli connection modify bc204 connection.wait-device-timeout 0
  else
    # Deliberately no gateway and no DNS: point-to-point cable to the
    # lighting controller. Wi-Fi must stay the default route.
    #
    # wait-device-timeout 0 matters as much as the addressing: the BC-204
    # cable is routinely unplugged, and with the default (-1) NM never calls
    # startup complete, so NetworkManager-wait-online blocks the whole boot
    # for a minute and then fails. The desktop reports that as a stream of
    # "disconnecting from network" notifications.
    sudo nmcli connection add type ethernet ifname eth0 con-name bc204 \
      ipv4.method manual \
      ipv4.addresses 192.168.10.10/24 \
      ipv6.method disabled \
      connection.autoconnect yes \
      connection.wait-device-timeout 0
    sudo nmcli connection up bc204 || warn "could not bring up bc204 — is the cable connected?"
  fi
  if ping -c 2 -W 2 192.168.10.20 >/dev/null 2>&1; then
    info "BC-204 responds at 192.168.10.20"
  else
    warn "no reply from 192.168.10.20 — set the BC-204 to 192.168.10.20/24 in its own web UI"
  fi

  # Wi-Fi power save costs far more than it saves on a cart that is running off
  # a traction battery anyway. With it on, the card sleeps through the first
  # DHCP exchange after association: the transaction burns its full timeout,
  # NetworkManager retries, and startup-complete lands after
  # NetworkManager-wait-online has already given up — a failed unit and a
  # minute of boot, reported on the desktop as repeated disconnect notices.
  # Measured on a Pi 4B: 1min 12s of boot with power save on, 33s with it off.
  wifi_con="$(nmcli -t -f NAME,TYPE connection show --active 2>/dev/null \
    | awk -F: '$2=="802-11-wireless"{print $1; exit}')"
  if [ -n "${wifi_con}" ]; then
    sudo nmcli connection modify "${wifi_con}" 802-11-wireless.powersave 2
    sudo nmcli connection modify "${wifi_con}" ipv4.dhcp-timeout 20
    info "wifi '${wifi_con}': power save disabled, dhcp timeout 20s"
  else
    warn "no active Wi-Fi connection found — skipping power save fix"
  fi
fi

# ------------------------------------------------------ 4. systemd unit ---
if [ "$DO_SERVICE" -eq 1 ]; then
  step "Persistent journal"
  # Without this the logs live in tmpfs and every power cycle destroys them,
  # which is how the first BC-204 bring-up ended up with nothing to inspect.
  # 99- so it sorts after Raspberry Pi OS's own
  # /usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf. Drop-ins are
  # ordered by filename across every directory, so a lower number silently
  # loses to it no matter that this one lives in /etc.
  jdrop=/etc/systemd/journald.conf.d/99-golfcart-persist.conf
  sudo rm -f /etc/systemd/journald.conf.d/10-golfcart-persist.conf
  if [ -f "${APP_DIR}/scripts/journald-persist.conf" ]; then
    sudo install -D -m 0644 "${APP_DIR}/scripts/journald-persist.conf" "$jdrop"
    sudo mkdir -p /var/log/journal
    sudo systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
    sudo systemctl restart systemd-journald
    storage="$(sudo systemd-analyze cat-config systemd/journald.conf 2>/dev/null \
      | grep -E '^\s*Storage=' | tail -1 | cut -d= -f2)"
    info "journal storage: ${storage:-unknown} (was volatile on a stock image)"
  else
    warn "scripts/journald-persist.conf missing — logs will not survive a reboot"
  fi

  # The cart runs isolated, so "wait for the network to be online" is waiting
  # for something that never arrives: with no AP in range the unit burns its
  # full 60s timeout and then fails, on every boot, before anything else in
  # multi-user.target may start. Disabling it lets network-online.target
  # complete trivially for the things that still pull it in (cloud-init), while
  # NetworkManager keeps configuring interfaces in the background exactly as
  # before — Wi-Fi still connects, it just no longer gates the boot.
  if systemctl is-enabled NetworkManager-wait-online.service >/dev/null 2>&1; then
    step "Boot: stop waiting for a network the cart may not have"
    sudo systemctl disable NetworkManager-wait-online.service >/dev/null 2>&1
    info "NetworkManager-wait-online disabled (was costing up to 60s per boot)"
  fi

  step "systemd service"
  src="${APP_DIR}/scripts/golfcart-lighting.service"
  [ -f "$src" ] || die "missing ${src}"
  tmp="$(mktemp)"
  # Retarget the unit at this user and install path. XDG_RUNTIME_DIR has to
  # match the real uid or theme audio cannot reach the session's PipeWire.
  sed -e "s|^User=pi$|User=${RUN_USER}|" \
      -e "s|/home/pi/golf-cart-lighting|${APP_DIR}|g" \
      -e "s|^ExecStart=/usr/bin/node|ExecStart=$(command -v node)|" \
      -e "s|^Environment=XDG_RUNTIME_DIR=/run/user/1000$|Environment=XDG_RUNTIME_DIR=/run/user/$(id -u)|" \
      "$src" > "$tmp"
  sudo install -m 0644 "$tmp" /etc/systemd/system/golfcart-lighting.service
  rm -f "$tmp"
  info "User=${RUN_USER} (uid $(id -u)), WorkingDirectory=${APP_DIR}"
  sudo systemctl daemon-reload
  sudo systemctl enable golfcart-lighting

  # `enable --now` only starts a unit that is stopped. On a re-run after a code
  # pull it is a no-op, leaving the old build serving — new routes 404 and the
  # old config stays live, which looks like the deploy silently failing.
  # Restarting is unconditional; the unit's SIGTERM handler zeroes DMX on the
  # way down, so the lights do not latch.
  sudo systemctl restart golfcart-lighting

  port="$(grep -o '"httpPort"[[:space:]]*:[[:space:]]*[0-9]*' "${APP_DIR}/config/network.json" 2>/dev/null \
    | grep -o '[0-9]*$' || echo 3100)"
  for _ in $(seq 1 20); do
    curl -fsS -o /dev/null "http://localhost:${port}/healthz" 2>/dev/null && break
    sleep 1
  done
  if systemctl is-active --quiet golfcart-lighting; then
    info "service is running (restarted onto the current build)"
  else
    warn "service did not start — journalctl -u golfcart-lighting -n 50"
  fi
fi

# ----------------------------------------------------- 5. Chromium kiosk ---
if [ "$DO_KIOSK" -eq 1 ]; then
  # Touch has to arrive as touch, not as an emulated mouse.
  #
  # Raspberry Pi OS ships labwc with mouseEmulation="yes" for the DSI panels,
  # in /usr/lib/../xdg/labwc/rc.xml and again in the generated user rc.xml.
  # With it on, the compositor rewrites every touch into a pointer event before
  # any client sees it, so a browser gets pointerType "mouse" and no
  # touchstart at all. Taps, sliders and dragging a scrollbar still work —
  # those are all things a mouse does — but drag-to-scroll is impossible,
  # because a mouse drag has never scrolled a container.
  #
  # Measured on this panel: with emulation on, a swipe produced 175
  # pointermove:mouse and zero touch events; with it off, the same swipe
  # produced 74 touchmove and scrolled the list 66 times. No amount of CSS or
  # Chromium flags can fix it from above.
  step "Touchscreen: deliver real touch events"
  rc_user="${HOME}/.config/labwc/rc.xml"
  rc_system=/etc/xdg/labwc/rc.xml
  # Order matters: the system file always keeps mouseEmulation="yes", so a
  # check against it must come last or a re-run overwrites a user file that was
  # already correct.
  if [ -f "$rc_user" ] && grep -q 'mouseEmulation="no"' "$rc_user" \
     && ! grep -q 'mouseEmulation="yes"' "$rc_user"; then
    info "already disabled"
  elif [ -f "$rc_user" ] && grep -q 'mouseEmulation="yes"' "$rc_user"; then
    cp -n "$rc_user" "${rc_user}.orig" 2>/dev/null || true
    sed -i 's/mouseEmulation="yes"/mouseEmulation="no"/g' "$rc_user"
    info "mouseEmulation disabled in ~/.config/labwc/rc.xml"
  elif [ -f "$rc_system" ] && grep -q 'mouseEmulation="yes"' "$rc_system"; then
    # No user override yet: create one carrying just the touch lines, flipped.
    mkdir -p "$(dirname "$rc_user")"
    {
      printf '<?xml version="1.0"?>\n<openbox_config xmlns="http://openbox.org/3.4/rc">\n'
      grep '<touch ' "$rc_system" | sed 's/mouseEmulation="yes"/mouseEmulation="no"/g'
      printf '</openbox_config>\n'
    } > "$rc_user"
    info "created ~/.config/labwc/rc.xml with mouseEmulation off"
  else
    warn "no labwc <touch> config found — if drag-to-scroll fails, check mouseEmulation"
  fi

  # ---- desktop launchers + keyboard shortcuts ----
  #
  # Closing the kiosk (Alt+F4, or a crash) otherwise leaves a bare desktop with
  # no obvious way back in short of a terminal, which is no use on a cart.
  step "Desktop shortcuts"
  chmod +x "${APP_DIR}/scripts/desktop-actions.sh"
  mkdir -p "${HOME}/Desktop"
  installed=0
  for src in "${APP_DIR}"/scripts/desktop/*.desktop; do
    [ -f "$src" ] || continue
    dest="${HOME}/Desktop/$(basename "$src")"
    sed "s|__APP_DIR__|${APP_DIR}|g" "$src" > "$dest"
    # pcmanfm refuses to launch a .desktop that is not executable, and marks it
    # trusted once it is.
    chmod +x "$dest"
    installed=$((installed + 1))
  done
  info "${installed} launcher(s) in ~/Desktop"

  # Keybinds go in the *user* rc.xml. Safe because the Pi session runs
  # `labwc -m` (--merge-config), so this augments the system bindings rather
  # than replacing them — without -m, the first file found wins outright and
  # this would silently delete Ctrl+Alt+T and everything else.
  rc_user="${HOME}/.config/labwc/rc.xml"
  if [ -f "$rc_user" ] && ! grep -q 'desktop-actions.sh kiosk' "$rc_user"; then
    if pgrep -a labwc | grep -qE ' -m( |$)|--merge-config'; then
      cp -n "$rc_user" "${rc_user}.pre-shortcuts" 2>/dev/null || true
      binds="  <keyboard>\n"
      binds="${binds}    <keybind key=\"C-A-k\"><action name=\"Execute\"><command>${APP_DIR}/scripts/desktop-actions.sh kiosk</command></action></keybind>\n"
      binds="${binds}    <keybind key=\"C-A-s\"><action name=\"Execute\"><command>${APP_DIR}/scripts/desktop-actions.sh status</command></action></keybind>\n"
      binds="${binds}  </keyboard>"
      sed -i "s|</openbox_config>|${binds}\n</openbox_config>|" "$rc_user"
      info "shortcuts: Ctrl+Alt+K reopens the kiosk, Ctrl+Alt+S shows status"
    else
      warn "labwc is not running with --merge-config; skipping keybinds so the system ones survive"
    fi
  fi

  step "Chromium kiosk"

  # Trixie ships `chromium`; older releases shipped `chromium-browser`. Install
  # whichever this release actually has — on Trixie the chromium-browser
  # package is a stale compatibility build several major versions behind.
  if apt-cache policy chromium 2>/dev/null | grep -q 'Candidate: [0-9]'; then
    sudo apt-get install -y chromium
  else
    sudo apt-get install -y chromium-browser
  fi
  sudo apt-get install -y unclutter || warn "unclutter unavailable (X11 only) — cursor will stay visible"

  chmod +x "${APP_DIR}/scripts/start-kiosk.sh"

  # The desktop session decides which autostart mechanism applies. labwc and
  # wayfire (Wayland) do not read ~/.config/autostart, so write whichever the
  # installed compositor honours.
  wrote=""
  if [ -d "${HOME}/.config/labwc" ] || dpkg -s labwc >/dev/null 2>&1; then
    mkdir -p "${HOME}/.config/labwc"
    auto="${HOME}/.config/labwc/autostart"
    touch "$auto"
    if ! grep -qF "start-kiosk.sh" "$auto" 2>/dev/null; then
      printf '%s &\n' "${APP_DIR}/scripts/start-kiosk.sh" >> "$auto"
    fi
    chmod +x "$auto"
    wrote="${wrote} ~/.config/labwc/autostart"
  fi
  if dpkg -s wayfire >/dev/null 2>&1 && [ -f "${HOME}/.config/wayfire.ini" ]; then
    if ! grep -qF "start-kiosk.sh" "${HOME}/.config/wayfire.ini"; then
      printf '\n[autostart]\nkiosk = %s\n' "${APP_DIR}/scripts/start-kiosk.sh" \
        >> "${HOME}/.config/wayfire.ini"
    fi
    wrote="${wrote} ~/.config/wayfire.ini"
  fi
  # Only fall back to XDG autostart when no compositor-specific entry was
  # written. Installing both makes the session launch two kiosks that then
  # race each other over the Chromium profile lock.
  if [ -z "${wrote}" ]; then
    mkdir -p "${HOME}/.config/autostart"
    sed "s|/home/pi/golf-cart-lighting|${APP_DIR}|g" \
      "${APP_DIR}/scripts/kiosk.desktop" > "${HOME}/.config/autostart/kiosk.desktop"
    wrote="${wrote} ~/.config/autostart/kiosk.desktop"
  else
    # Clear a stale XDG entry left by an earlier run of this installer.
    rm -f "${HOME}/.config/autostart/kiosk.desktop"
  fi
  info "autostart:${wrote}"

  # A kiosk is pointless if the Pi boots to a console. Note the polarity:
  # get_boot_cli echoes 1 for a graphical boot and 0 for CLI, so 0 is the
  # case that needs changing.
  if command -v raspi-config >/dev/null 2>&1; then
    if [ "$(sudo raspi-config nonint get_boot_cli 2>/dev/null)" = "0" ]; then
      info "console boot detected — switching to desktop + autologin"
      sudo raspi-config nonint do_boot_behaviour B4
    else
      info "already boots to desktop"
      # Desktop boot without autologin still stops at a login screen.
      if [ "$(sudo raspi-config nonint get_autologin 2>/dev/null)" != "0" ]; then
        info "enabling desktop autologin"
        sudo raspi-config nonint do_boot_behaviour B4
      fi
    fi
  else
    warn "raspi-config missing — set boot-to-desktop yourself or the kiosk will not appear"
  fi
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
  # hostnamectl does not touch /etc/hosts. Leaving the old name there makes
  # every sudo call emit "unable to resolve host" and stall on the lookup.
  if ! grep -qE "^127\.0\.1\.1[[:space:]]+${HOSTNAME_NEW}([[:space:]]|$)" /etc/hosts; then
    if grep -qE '^127\.0\.1\.1' /etc/hosts; then
      sudo sed -i "s|^\(127\.0\.1\.1[[:space:]]\+\).*|\1${HOSTNAME_NEW}|" /etc/hosts
    else
      printf '127.0.1.1\t%s\n' "${HOSTNAME_NEW}" | sudo tee -a /etc/hosts >/dev/null
    fi
    info "/etc/hosts 127.0.1.1 -> ${HOSTNAME_NEW}"
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
