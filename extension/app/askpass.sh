#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Answers ssh's password prompt during server setup, and nothing else. A code or any
# other question makes the login fail with a message the app can explain.
case "$1" in
*[Pp]assword*) printf '%s\n' "$SCREENSHOT_TRAY_PASSWORD" ;;
*) echo 'screenshot-tray: unsupported prompt' >&2; exit 1 ;;
esac
