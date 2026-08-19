#!/usr/bin/env bash
#
# Launch Chromium in kiosk mode pointing at the local lighting controller.
# Waits for the Node service to answer /healthz first so the touchscreen never
# shows a connection-error page during boot.

set -euo pipefail

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
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0 &

exec chromium-browser \
  --kiosk \
  --app="${URL}" \
  --incognito \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required
