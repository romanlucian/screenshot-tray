#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs Screenshot Tray for this user only: no sudo, no system files.
# Adds one link and one entry in GNOME's list of add-ons; uninstall.sh removes both.
set -euo pipefail

UUID=screenshot-tray@lucibe.com
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINK="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Also works over SSH: talk to the desktop's settings service.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "/run/user/$(id -u)/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
fi

if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    echo "Stopping: $LINK already exists and is not this project's link." >&2
    exit 1
fi
mkdir -p "$(dirname "$LINK")"
ln -sfn "$HERE/extension" "$LINK"

# The app's icon and its entry in the app list.
ICON="$HOME/.local/share/icons/hicolor/scalable/apps/com.lucibe.ScreenshotTray.svg"
LAUNCHER="$HOME/.local/share/applications/com.lucibe.ScreenshotTray.desktop"
mkdir -p "$(dirname "$ICON")" "$(dirname "$LAUNCHER")"
ln -sfn "$HERE/data/com.lucibe.ScreenshotTray.svg" "$ICON"
sed "s|@APP@|$HERE/extension/app/main.js|" "$HERE/data/com.lucibe.ScreenshotTray.desktop.in" > "$LAUNCHER"

enabled=$(gsettings get org.gnome.shell enabled-extensions)
updated=$(python3 "$HERE/scripts/extension_list.py" add "$UUID" "$enabled")
gsettings set org.gnome.shell enabled-extensions "$updated"

echo "Installed. Log out and back in once; after that the tray starts by itself."
