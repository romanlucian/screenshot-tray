#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the setup and sending tests against real SSH servers: throwaway Docker containers
# with made-up users, reachable on 127.0.0.1 only. The tests use a made-up home folder,
# and this script fails if anything in the real ~/.ssh changed.
# Needs: Docker.
#     tests/integration.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d -p /var/tmp screenshot-tray-integration.XXXXXX)"
CONTAINER=""
AGENT_PID=""
cleanup() {
    [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1
    [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

real_ssh_files() {
    find "$HOME/.ssh" -type f -exec sha256sum {} + 2>/dev/null | sort
}
BEFORE="$(real_ssh_files)"

# A key the "this computer already logs in with a key" tests log in with.
ssh-keygen -q -t ed25519 -N '' -C test-agent-key -f "$WORK/agent-key"
eval "$(ssh-agent -s)" >/dev/null
AGENT_PID="$SSH_AGENT_PID"
ssh-add -q "$WORK/agent-key"

mkdir -p "$WORK/home" "$WORK/config"
head -c 400M /dev/zero > "$WORK/big.png"

status=0
for image in ubuntu alpine; do
    echo "== $image"
    timeout 5m docker build -q -t "screenshot-tray-test-$image" \
        -f "$HERE/tests/docker/$image.Dockerfile" "$HERE/tests/docker" >/dev/null
    CONTAINER="screenshot-tray-test-$image-$$"
    timeout 1m docker run -d --rm --name "$CONTAINER" --memory=256m --pids-limit=128 \
        -p 127.0.0.1::22 "screenshot-tray-test-$image" >/dev/null
    docker exec -i "$CONTAINER" sh -c 'cat > /home/keyonly/.ssh/authorized_keys; chown keyonly:keyonly /home/keyonly/.ssh/authorized_keys; chmod 600 /home/keyonly/.ssh/authorized_keys' \
        < "$WORK/agent-key.pub"
    PORT="$(docker port "$CONTAINER" 22/tcp | head -1 | sed 's/.*://')"
    HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" TEST_PORT="$PORT" TEST_CONTAINER="$CONTAINER" \
        TEST_IMAGE="$image" TEST_BIG_FILE="$WORK/big.png" \
        timeout 8m gjs -m "$HERE/tests/integration-test.js" || status=1
    docker rm -f "$CONTAINER" >/dev/null
    CONTAINER=""
done

if [ "$BEFORE" != "$(real_ssh_files)" ]; then
    echo "FAIL  something changed in the real ~/.ssh"
    status=1
else
    echo "ok    the real ~/.ssh is unchanged"
fi
exit "$status"
