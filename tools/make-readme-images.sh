#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Makes the README images (docs/hero.png, docs/tray.png) from the real tray, drawn
# off-screen by GTK's Broadway backend: nothing appears on the desktop, and the
# screenshots shown are the made-up ones in tools/demo, never real ones.
# Needs: gtk4-broadwayd (libgtk-4-bin), python3-gi, python3-cairo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
BROADWAY_PID=""
trap '[ -n "$BROADWAY_PID" ] && kill "$BROADWAY_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

python3 "$HERE/tools/render_demo_shots.py" "$HERE/tools/demo" "$WORK/shots"

# A private Broadway display, reachable from this computer only.
DISPLAY_NUMBER=13
gtk4-broadwayd --address 127.0.0.1 --port 8093 ":$DISPLAY_NUMBER" >"$WORK/broadway.log" 2>&1 &
BROADWAY_PID=$!
for _ in $(seq 50); do
    ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/broadway*.socket >/dev/null 2>&1 && break
    sleep 0.1
done

# Its own message bus too, so it never meets the tray that is already running.
dbus-run-session -- env GDK_BACKEND=broadway BROADWAY_DISPLAY=":$DISPLAY_NUMBER" \
    ADW_DEBUG_COLOR_SCHEME=prefer-dark \
    SCREENSHOT_TRAY_DIR="$WORK/shots" SCREENSHOT_TRAY_STATE="$WORK/cards.json" \
    gjs -m "$HERE/extension/app/main.js" --managed --preload=3 --render="$WORK/tray.png"

python3 "$HERE/tools/compose_readme_images.py" "$WORK/tray.png" "$WORK/shots" "$HERE/docs"
