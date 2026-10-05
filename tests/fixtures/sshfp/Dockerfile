# Registry index and platform digests are recorded in ubuntu-base.json.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ENV DEBIAN_FRONTEND=noninteractive
# Do not retain package-generated host identities in an image layer. Every lab
# creates only ephemeral SSH server identities and DNS signing keys at runtime.
# Unpack the native BIND server without its maintainer script: a normal bind9
# install creates an rndc client-authentication key, which this lab must not hold.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        bind9-utils dns-root-data dnsutils iproute2 libcap2 libsystemd0 \
        netbase openssh-client openssh-server python3 sudo unbound \
    && rm -f /etc/ssh/ssh_host_* \
    && apt-get download bind9 \
    && dpkg-deb --extract /bind9_*.deb / \
    && rm -f /bind9_*.deb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash runner \
    && useradd --create-home --shell /bin/bash tarubot \
    && passwd -d tarubot \
    && printf 'runner ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/fixture-runner \
    && chmod 440 /etc/sudoers.d/fixture-runner \
    && mkdir -p /run/sshd /transport

COPY lab.py remote-command.py /fixture/
ENTRYPOINT ["python3", "/fixture/lab.py"]
