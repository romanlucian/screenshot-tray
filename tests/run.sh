#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the tests that need no display and no server, in a made-up home folder.
#     tests/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d -p /var/tmp screenshot-tray-tests.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/config"

status=0
for name in servers-test.js ssh-test.js; do
    echo "== $name"
    HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" \
        timeout 2m gjs -m "$HERE/tests/$name" || status=1
done
exit "$status"
