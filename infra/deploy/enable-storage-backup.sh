#!/usr/bin/env bash
# One-time host administrator action; the CI deploy key intentionally cannot change this fixed script.
set -euo pipefail
[[ "$(id -u)" = 0 ]] || { echo 'Run this on the production host as root.' >&2; exit 1; }
release="$(readlink -f /opt/astella/current)"
[[ "$release" =~ ^/opt/astella/releases/[0-9a-f]{40}-[0-9a-f]{12}$ ]] || exit 1
test -s "$release/infra/deploy/docker-compose.storage-backup.yml"
test -s /etc/astella/production.env
install -o root -g root -m 755 "$release/infra/deploy/deploy.sh" /usr/local/lib/astella/deploy.sh
if grep -q '^STORAGE_BACKUP_ENABLED=' /etc/astella/production.env; then
  sed -i 's/^STORAGE_BACKUP_ENABLED=.*/STORAGE_BACKUP_ENABLED=true/' /etc/astella/production.env
else
  printf '\nSTORAGE_BACKUP_ENABLED=true\n' >> /etc/astella/production.env
fi
chmod 600 /etc/astella/production.env
echo 'Standby configuration prepared. Re-run this release deployment in Actions to initialize its private bucket and queue.'
