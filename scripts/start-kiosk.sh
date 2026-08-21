#!/usr/bin/env bash
#
# Launch Chromium in kiosk mode pointing at the local lighting controller.
# Waits for the Node service to answer /healthz first so the touchscreen never
# shows a connection-error page during boot.

set -euo pipefail

# A desktop session can fire more than one autostart mechanism (labwc's
# autostart and the XDG entry both, say), and a second Chromium against the
# same profile races the first over its lock. Hold an flock for the lifetime
# of the browser — the exec'd process inherits the descriptor — so only the
# first invocation gets through.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/golfcart-kiosk.lock"
exec 9>"${LOCK}"
if ! flock -n 9; then
  echo "kiosk already running (lock held on ${LOCK}) — exiting"
  exit 0
fi

PORT="${LIGHTING_PORT:-3100}"
URL="http://localhost:${PORT}"

echo "waiting for ${URL}/healthz ..."
for _ in $(seq 1 60); do
  if curl -fsS "${URL}/healthz" >/dev/null 2>&1; then
    echo "controller is up"
    break
  fi
  sleep 1
done

# Clear crash flags so Chromium never shows the "restore pages?" bubble after
# an abrupt power-off — which is the normal way a golf cart gets switched off.
PROFILE="${HOME}/.config/chromium/Default/Preferences"
if [ -f "${PROFILE}" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "${PROFILE}" || true
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "${PROFILE}" || true
fi

# Blank the cursor on a touch-only panel if unclutter is installed.
# unclutter is X11-only, so this is a no-op under a Wayland session (labwc).
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0 &

# Trixie ships the binary as `chromium`; earlier releases used
# `chromium-browser`. Prefer whichever exists rather than assuming.
BROWSER=""
for candidate in chromium chromium-browser; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    BROWSER="${candidate}"
    break
  fi
done
[ -n "${BROWSER}" ] || { echo "no chromium binary found" >&2; exit 1; }
echo "using ${BROWSER}"

# --password-store=basic keeps Chromium away from the system keyring. With
# lightdm autologin the login keyring is never unlocked — PAM never sees a
# password — so asking for it puts an "Unlock Keyring" dialog over the kiosk on
# every boot. The cart stores no credentials, so the basic store loses nothing.
exec "${BROWSER}" \
  --kiosk \
  --ozone-platform-hint=auto \
  --password-store=basic \
  --app="${URL}" \
  --incognito \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required
