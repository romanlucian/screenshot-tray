#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Removes everything install.sh added. Your screenshots are never touched.
set -euo pipefail

UUID=screenshot-tray@zincoo.com
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINK="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "/run/user/$(id -u)/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
fi

# Switching the add-on off also closes the tray window.
gnome-extensions disable "$UUID" 2>/dev/null || true

for key in enabled-extensions disabled-extensions; do
    current=$(gsettings get org.gnome.shell "$key")
    updated=$(python3 "$HERE/scripts/extension_list.py" remove "$UUID" "$current")
    gsettings set org.gnome.shell "$key" "$updated"
done

if [ -L "$LINK" ]; then
    rm "$LINK"
fi
ICON="$HOME/.local/share/icons/hicolor/scalable/apps/com.zincoo.ScreenshotTray.svg"
if [ -L "$ICON" ]; then
    rm "$ICON"
fi
rm -f "$HOME/.local/share/applications/com.zincoo.ScreenshotTray.desktop"
rm -rf "$HOME/.cache/screenshot-tray"
pkill -f "$UUID/app/main.js" 2>/dev/null || true
pkill -f "$HERE/extension/app/main.js" 2>/dev/null || true

echo "Removed. Nothing of Screenshot Tray is left outside this folder."
