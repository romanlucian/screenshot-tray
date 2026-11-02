#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the real add-on and the real tray inside a separate, invisible GNOME Shell, with a
# made-up home folder, a memory limit, no network at all, and private message buses in
# place of both the session bus and the system bus, so it can't reach your login, GDM or
# anything else of your desktop. Then it presses real keys and clicks the real gear there.
#     tests/addon.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDON=screenshot-tray@zincoo.com
PROBE=probe@screenshot-tray.test

if [ "${1:-}" != --inside ]; then
    WORK="$(mktemp -d -p /var/tmp screenshot-tray-addon.XXXXXX)"
    # Helpers of the invisible desktop can take a moment to go, so try twice.
    trap 'rm -rf "$WORK" || { sleep 2; rm -rf "$WORK"; }; sleep 1; rm -rf "$WORK"' EXIT
    chmod 700 "$WORK"
    mkdir -p "$WORK/run" "$WORK/config/glib-2.0/settings" "$WORK/shots" "$WORK/pictures" \
        "$WORK/data/gnome-shell/extensions" "$WORK/home/.ssh"
    chmod 700 "$WORK/run"
    ln -s "$HERE/extension" "$WORK/data/gnome-shell/extensions/$ADDON"
    ln -s "$HERE/tests/addon-probe" "$WORK/data/gnome-shell/extensions/$PROBE"
    mkdir -p "$WORK/data/applications"
    sed "s|@APP@|$HERE/extension/app/main.js|" "$HERE/data/com.zincoo.ScreenshotTray.desktop.in" \
        > "$WORK/data/applications/com.zincoo.ScreenshotTray.desktop"
    cat > "$WORK/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$ADDON', '$PROBE']
allow-extension-installation=false
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
enable-animations=false

[org/gnome/desktop/notifications]
show-banners=false
EOF
    printf 'Host build-box\n    HostName 203.0.113.40\n' > "$WORK/home/.ssh/config"
    python3 - "$WORK/pictures" <<'PY'
import sys
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
for number in range(1, 5):
    picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 800, 400)
    picture.fill(0x336699ff)
    picture.savev(f'{sys.argv[1]}/shot-{number}.png', 'png', [], [])
PY
    status=0
    systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 -- \
        timeout 6m unshare --user --map-current-user --net -- dbus-run-session -- \
        env -u DISPLAY -u XAUTHORITY -u XDG_SESSION_ID -u GNOME_SHELL_SESSION_MODE \
        WORK="$WORK" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_RUNTIME_DIR="$WORK/run" \
        XDG_DATA_HOME="$WORK/home/.local/share" XDG_CACHE_HOME="$WORK/home/.cache" \
        XDG_DATA_DIRS="$WORK/data:/usr/local/share:/usr/share" \
        GSETTINGS_BACKEND=keyfile GSK_RENDERER=cairo PATH="$HERE/tests/fakes:$PATH" \
        FAKE_SSH_LOG="$WORK/ssh.log" FAKE_SSH_OUTPUT="" WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland \
        SCREENSHOT_TRAY_DIR="$WORK/shots" SCREENSHOT_TRAY_STATE="$WORK/cards.json" \
        "$0" --inside || status=$?
    if [ "$status" -ne 0 ] && [ -f "$WORK/shell.log" ]; then
        echo "--- the end of the invisible GNOME Shell's log"
        grep -E "could not send|Screenshot Tray: (sent|drag)|JS ERROR" "$WORK/shell.log" | tail -8 || true
        tail -6 "$WORK/shell.log"
    fi
    exit "$status"
fi

if grep -qv '^Iface' /proc/net/route; then
    echo "Refusing to run: this was meant to have no network." >&2
    exit 2
fi
export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 >"$WORK/shell.log" 2>&1 &
SHELL_PID=$!
stop_shell() {
    kill "$SHELL_PID" 2>/dev/null || true
    wait "$SHELL_PID" 2>/dev/null || true
}
trap stop_shell EXIT

gdbus wait --session --timeout 90 org.gnome.Shell

status=0
gjs -m "$HERE/tests/addon-test.js" || status=$?

# The file an error comes from is on the lines after the error itself.
if grep -A8 -E "JS ERROR|Gjs-CRITICAL" "$WORK/shell.log" | grep -E "$ADDON|/extension/(app/|extension\.js)"; then
    echo "FAIL  the log above shows errors from the add-on or the tray"
    status=1
fi
exit "$status"
