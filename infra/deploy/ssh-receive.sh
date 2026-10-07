#!/usr/bin/env bash
# Installed as a root-owned forced SSH command. No interactive shell or SCP.
set -euo pipefail
umask 077
if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deployment of a full commit SHA is supported' >&2
  exit 1
fi
commit="${BASH_REMATCH[1]}"
exec 9>/opt/astella/deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }

# The workflow token expires after the job. Never retain registry credentials.
IFS= read -r registry_user
[[ "$registry_user" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 1
IFS= read -r registry_token
test -n "$registry_token"
export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d)"
bundle="$(mktemp -d /opt/astella/releases/.incoming.XXXXXX)"
trap 'rm -rf "$DOCKER_CONFIG" "$bundle"' EXIT
printf '%s' "$registry_token" | docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null 2>&1
unset registry_token
python /usr/local/lib/astella/extract-bundle.py "$bundle"
test -s "$bundle/deployment-images.env"
test -s "$bundle/docker-compose.deploy.yml"
image_set="$(sha256sum "$bundle/deployment-images.env" | cut -c1-12)"
release="/opt/astella/releases/$commit-$image_set"
# Preserve an existing release, including an active release being retried.
if [[ -e "$release" ]]; then
  cmp "$bundle/deployment-images.env" "$release/deployment-images.env" >/dev/null || {
    echo 'An existing image set cannot be replaced' >&2; exit 1;
  }
else
  mv "$bundle" "$release"
fi
/usr/local/lib/astella/deploy.sh "$release"
