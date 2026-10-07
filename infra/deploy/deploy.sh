#!/usr/bin/env bash
set -euo pipefail
umask 077
release="${1:?release directory required}"
[[ "$release" =~ ^/opt/astella/releases/[0-9a-f]{40}$ ]] || exit 1
env_file=/etc/astella/production.env
test -s "$env_file"
test -s /etc/letsencrypt/live/astella-ip/fullchain.pem
compose=(docker compose --project-name astella --project-directory "$release"
  --env-file "$env_file" --env-file "$release/deployment-images.env"
  -f "$release/docker-compose.yml" -f "$release/docker-compose.deploy.yml" --profile storage)
previous="$(readlink -f /opt/astella/current 2>/dev/null || true)"
rollback() {
  result=$?
  if (( result != 0 )) && [[ -n "$previous" && "$previous" != "$release" ]]; then
    echo 'Deployment failed; restarting the previous application images. Database backup is retained.' >&2
    docker compose --project-name astella --project-directory "$previous" \
      --env-file "$env_file" --env-file "$previous/deployment-images.env" \
      -f "$previous/docker-compose.yml" -f "$previous/docker-compose.deploy.yml" --profile storage \
      up -d --no-build --pull never --no-deps api worker nginx || true
  fi
  exit "$result"
}
trap rollback EXIT
"${compose[@]}" config --quiet
"${compose[@]}" pull --quiet postgres role-bootstrap role-grants minio minio-init api migrate worker edge-tts nginx
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 120 postgres minio edge-tts

# A logical backup precedes every migration, including the first empty database.
mkdir -p /opt/astella/backups
backup="/opt/astella/backups/$(date -u +%Y%m%dT%H%M%S)-$(basename "$release").dump"
# Expanded by the container shell, not the host.
# shellcheck disable=SC2016
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
"${compose[@]}" stop api worker
for service in role-bootstrap minio-init migrate role-grants; do
  "${compose[@]}" run --rm --no-deps "$service"
done
"${compose[@]}" up -d --no-build --pull never --no-deps --wait --wait-timeout 180 api worker nginx
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4000/ready >/dev/null
public_host="$(cat /etc/astella/public-host)"
curl --fail --silent --show-error --max-time 15 "https://$public_host/ready" >/dev/null
ln -sfn "$release" /opt/astella/current.next
mv -Tf /opt/astella/current.next /opt/astella/current
trap - EXIT
echo "Deployment healthy: $(basename "$release")"
