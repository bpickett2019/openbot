#!/bin/bash
# Run only on the clean Ubuntu 24.04 image builder selected by the operator.
# This installs the root supervisor, not an account, volume or running desktop.
# The same bundle is published with the fork release and its SHA-256 checksums.
set -euo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run image preparation as root.' >&2; exit 1; }
source /etc/os-release
[ "$ID:$VERSION_ID" = ubuntu:24.04 ] || { echo 'The builder must use Ubuntu 24.04.' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd)
[ ! -e /etc/openbot-host/config.json ] && [ ! -e /srv/openbot-volume/identity.json ] || {
  echo 'Do not capture an image from an initialized host.' >&2; exit 1;
}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends docker.io python3 iptables util-linux e2fsprogs ca-certificates cloud-init
install -d -m 0700 /etc/openbot-host
install -m 0755 "$source_dir/openbot-digitalocean-bootstrap" /usr/local/sbin/openbot-digitalocean-bootstrap
install -m 0600 "$source_dir/seccomp.json" /etc/openbot-host/seccomp.json
install -m 0644 "$source_dir/openbot-managed.service" /etc/systemd/system/openbot-managed.service
systemctl daemon-reload
systemctl enable docker.service
# No machine/user_data state or provider credentials may enter the custom image.
# cloud-init must process the new Droplet's configuration, not the builder's.
cloud-init clean --logs --machine-id
