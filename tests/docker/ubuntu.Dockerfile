# SPDX-License-Identifier: GPL-3.0-or-later
# A throwaway SSH server with made-up users, for tests/integration.sh.
FROM ubuntu:26.04
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && mkdir -p /run/sshd && rm -f /etc/ssh/sshd_config.d/* && ssh-keygen -A
COPY users.sh /users.sh
COPY sshd_config /etc/ssh/sshd_config
RUN sh /users.sh
CMD ["/usr/sbin/sshd", "-D", "-e"]
