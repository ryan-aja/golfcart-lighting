#!/usr/bin/env bash
#
# Select which rig this machine is wired for.
#
#   scripts/set-profile.sh lt890     use config/profiles/lt890/
#   scripts/set-profile.sh --none    use the flat config/ files (the golf cart)
#   scripts/set-profile.sh           show what is selected now
#
# Exists because the alternative is editing JSON over SSH, where the quoting
# goes through PowerShell, ssh and bash in turn and one stray character leaves
# a machine with an unparseable config. This validates the name against what is
# actually on disk before writing anything.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_FILE="${APP_DIR}/config/profile.json"
PROFILES_DIR="${APP_DIR}/config/profiles"

available() {
  [ -d "$PROFILES_DIR" ] || { echo "(none)"; return; }
  local found
  found="$(find "$PROFILES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f ' 2>/dev/null)"
  echo "${found:-(none)}"
}

# Paths go in as argv, never interpolated into the script text: it keeps odd
# characters out of the JS, and it means relative paths work the same under Git
# Bash on Windows, where an interpolated /d/... turns into D:\d\... and breaks.
current() {
  [ -f "$PROFILE_FILE" ] || { echo ""; return; }
  ( cd "$APP_DIR" && node -e '
      const fs = require("fs");
      try {
        const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(doc.active || ""));
      } catch { process.stdout.write(""); }
    ' config/profile.json ) 2>/dev/null || echo ""
}

if [ $# -eq 0 ]; then
  now="$(current)"
  echo "profile: ${now:-(none — using the flat config/ files)}"
  echo "available: $(available)"
  exit 0
fi

want="$1"
[ "$want" = "--none" ] && want=""

if [ -n "$want" ] && [ ! -d "${PROFILES_DIR}/${want}" ]; then
  echo "error: no profile \"${want}\" in ${PROFILES_DIR}" >&2
  echo "available: $(available)" >&2
  exit 1
fi

# Written with node rather than sed so the result is always valid JSON, and so
# the explanatory comment survives for whoever opens this file cold later.
( cd "$APP_DIR" && node -e '
    const fs = require("fs");
    const [file, example, want] = process.argv.slice(1);
    let doc = {};
    const source = fs.existsSync(file) ? file : example;
    try { doc = JSON.parse(fs.readFileSync(source, "utf8")); } catch {}
    doc.active = want;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  ' config/profile.json config/profile.example.json "$want" )

now="$(current)"
echo "profile: ${now:-(none — using the flat config/ files)}"
echo "restart to apply:  sudo systemctl restart golfcart-lighting"
