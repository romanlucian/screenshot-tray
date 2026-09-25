#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Draws the real parts of the app that the README pictures are made from: the tray,
# the "How to use" and "About" windows (dark style), the icon, and the made-up demo
# screenshots in tools/demo. Nothing appears on the desktop: GTK draws into a private,
# invisible Broadway display with its own message bus, and the server list shown is
# made up, so nothing of yours ends up in a picture.
# Needs: gtk4-broadwayd (libgtk-4-bin), python3-gi.
#     tools/render-app-parts.sh OUTPUT_FOLDER
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:?usage: render-app-parts.sh OUTPUT_FOLDER}" && cd "$1" && pwd)"
WORK="$(mktemp -d)"
BROADWAY_PID=""
cleanup() {
    [ -n "$BROADWAY_PID" ] && kill "$BROADWAY_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

# Runs a GTK program on a private, invisible display, then closes the display.
offscreen() {
    gtk4-broadwayd --address 127.0.0.1 --port 8097 :17 >/dev/null 2>&1 &
    BROADWAY_PID=$!
    for _ in $(seq 50); do
        ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/broadway*.socket >/dev/null 2>&1 && break
        sleep 0.1
    done
    dbus-run-session -- env GDK_BACKEND=broadway BROADWAY_DISPLAY=:17 \
        ADW_DEBUG_COLOR_SCHEME=prefer-dark "$@" 2>&1 | grep -E '^(drew|could not)|rendered' || true
    sleep 1     # let the program close before its display goes away
    kill "$BROADWAY_PID" 2>/dev/null
    wait "$BROADWAY_PID" 2>/dev/null || true
    BROADWAY_PID=""
}

python3 "$HERE/tools/render_demo_shots.py" "$HERE/tools/demo" "$OUT/shots"
python3 - "$HERE/data/com.zincoo.ScreenshotTray.svg" "$OUT/icon.png" <<'PY'
import sys
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
GdkPixbuf.Pixbuf.new_from_file_at_size(sys.argv[1], 512, 512).savev(sys.argv[2], 'png', [], [])
print(f'icon: {sys.argv[2]}')
PY

# A made-up home folder, so the "How to use" window lists made-up servers.
mkdir -p "$WORK/home/.ssh"
printf 'Host my-server\n    HostName 203.0.113.10\n\nHost build-box\n    HostName 203.0.113.20\n' \
    > "$WORK/home/.ssh/config"
offscreen env HOME="$WORK/home" XDG_DATA_HOME="$HOME/.local/share" \
    gjs -m "$HERE/tools/render_windows.js" "$OUT"

offscreen env SCREENSHOT_TRAY_DIR="$OUT/shots" SCREENSHOT_TRAY_STATE="$WORK/cards.json" \
    gjs -m "$HERE/extension/app/main.js" --managed --preload=3 --render="$OUT/tray.png"
