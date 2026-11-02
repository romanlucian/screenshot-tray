#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the window tests on an invisible display, in a made-up home folder.
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
mkdir -p "$WORK/home" "$WORK/config"

offscreen env HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$HOME/.local/share" \
    timeout 3m gjs -m "$HERE/tests/ui-test.js"
