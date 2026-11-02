#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the window tests on an invisible display, in a made-up home folder, with settings
# kept in memory, so your real shortcuts can't change.
# Needs: gtk4-broadwayd (libgtk-4-bin).
#     tests/ui.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tools/offscreen.sh
source "$HERE/tools/offscreen.sh"
WORK="$(mktemp -d -p /var/tmp screenshot-tray-ui.XXXXXX)"
cleanup() {
    [ -n "$BROADWAY_PID" ] && kill "$BROADWAY_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

status=0
for name in ui-test.js settings-tabs-test.js; do
    echo "== $name"
    rm -rf "$WORK/home" "$WORK/config"
    mkdir -p "$WORK/home" "$WORK/config"
    offscreen env HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$HOME/.local/share" \
        GSETTINGS_BACKEND=memory SCREENSHOT_TRAY_DIR="$WORK/shots" SCREENSHOT_TRAY_STATE="$WORK/cards.json" \
        timeout 3m gjs -m "$HERE/tests/$name" || status=1
done
exit "$status"
