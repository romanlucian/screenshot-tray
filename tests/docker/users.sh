#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# The made-up users of a throwaway test server. Runs while the image is built.
set -eu

for user in pw quoted keyonly noisy nonewline; do
    useradd -m -s /bin/sh "$user"
    mkdir -p "/home/$user/.ssh"
    chown -R "$user:$user" "/home/$user"
done

chpasswd <<'EOF'
pw:not-a-real-secret
quoted:p@ss w"o'r\d$é
keyonly:not-a-real-secret
noisy:not-a-real-secret
nonewline:not-a-real-secret
EOF

# A login shell that prints a welcome message for every command, even in scripts.
if command -v bash >/dev/null; then
    usermod -s /bin/bash noisy
    echo 'echo welcome' > /home/noisy/.bashrc
    chown noisy:noisy /home/noisy/.bashrc
fi
