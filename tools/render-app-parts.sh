#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Draws the real parts of the app that the README pictures are made from: the tray,
# the "How to use", "About", "Settings" and "Add a server" windows (dark style), the
# icon, and the made-up demo screenshots in tools/demo. Nothing appears on the desktop:
# GTK draws into a private, invisible Broadway display with its own message bus, and the
# servers shown are made up, so nothing of yours ends up in a picture.
# Needs: gtk4-broadwayd (libgtk-4-bin), python3-gi.
#     tools/render-app-parts.sh OUTPUT_FOLDER
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:?usage: render-app-parts.sh OUTPUT_FOLDER}" && cd "$1" && pwd)"
# shellcheck source=tools/offscreen.sh
source "$HERE/tools/offscreen.sh"
WORK="$(mktemp -d -p /var/tmp screenshot-tray-parts.XXXXXX)"
cleanup() {
    [ -n "$BROADWAY_PID" ] && kill "$BROADWAY_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

python3 "$HERE/tools/render_demo_shots.py" "$HERE/tools/demo" "$OUT/shots"
python3 - "$HERE/data/com.zincoo.ScreenshotTray.svg" "$OUT/icon.png" <<'PY'
import sys
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
GdkPixbuf.Pixbuf.new_from_file_at_size(sys.argv[1], 512, 512).savev(sys.argv[2], 'png', [], [])
print(f'icon: {sys.argv[2]}')
PY

# A made-up home folder, so every window shows made-up servers.
mkdir -p "$WORK/home/.ssh"
printf 'Host my-server\n    HostName 203.0.113.30\n\nHost build-box\n    HostName 203.0.113.40\n' \
    > "$WORK/home/.ssh/config"
MADE_UP=(HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_DATA_HOME="$HOME/.local/share"
    GSETTINGS_BACKEND=memory)
ONLY_RESULTS='^(drew|could not)|rendered'

offscreen env "${MADE_UP[@]}" timeout 2m gjs -m "$HERE/tools/render_windows.js" "$OUT" 2>&1 \
    | grep -E "$ONLY_RESULTS" || true

offscreen env "${MADE_UP[@]}" SCREENSHOT_TRAY_DIR="$OUT/shots" SCREENSHOT_TRAY_STATE="$WORK/cards.json" \
    timeout 1m gjs -m "$HERE/extension/app/main.js" --managed --preload=3 --render="$OUT/tray.png" 2>&1 \
    | grep -E "$ONLY_RESULTS" || true
