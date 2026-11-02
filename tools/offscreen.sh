# SPDX-License-Identifier: GPL-3.0-or-later
# Source this file. offscreen runs a GTK program on a private, invisible Broadway
# display with its own message bus, then closes the display: nothing appears on the
# desktop. It returns the program's exit status.
# Needs: gtk4-broadwayd (libgtk-4-bin), dbus-run-session.

BROADWAY_PID=""

offscreen() {
    gtk4-broadwayd --address 127.0.0.1 --port 8097 :17 >/dev/null 2>&1 &
    BROADWAY_PID=$!
    for _ in $(seq 50); do
        ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/broadway*.socket >/dev/null 2>&1 && break
        sleep 0.1
    done
    local status=0
    dbus-run-session -- env GDK_BACKEND=broadway BROADWAY_DISPLAY=:17 \
        ADW_DEBUG_COLOR_SCHEME=prefer-dark "$@" || status=$?
    sleep 1     # let the program close before its display goes away
    kill "$BROADWAY_PID" 2>/dev/null
    wait "$BROADWAY_PID" 2>/dev/null || true
    BROADWAY_PID=""
    return "$status"
}
