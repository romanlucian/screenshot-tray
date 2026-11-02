# SPDX-License-Identifier: GPL-3.0-or-later
# A throwaway SSH server with made-up users and a different sh, for tests/integration.sh.
FROM alpine:3
RUN apk add --no-cache openssh shadow && ssh-keygen -A
COPY users.sh /users.sh
COPY sshd_config /etc/ssh/sshd_config
RUN sh /users.sh
CMD ["/usr/sbin/sshd", "-D", "-e"]
