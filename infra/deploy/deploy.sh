#!/usr/bin/env bash
set -euo pipefail
umask 077
release="${1:?release directory required}"
[[ "$release" =~ ^/opt/astella/releases/[0-9a-f]{40}(-[0-9a-f]{12})?$ ]] || exit 1
env_file=/etc/astella/production.env
test -s "$env_file"
test -s /etc/letsencrypt/live/astella-ip/fullchain.pem
compose=(docker compose --project-name astella --project-directory "$release"
  --env-file "$env_file" --env-file "$release/deployment-images.env"
  -f "$release/docker-compose.yml" -f "$release/docker-compose.deploy.yml")
previous="$(readlink -f /opt/astella/current 2>/dev/null || true)"
rollback() {
  result=$?
  if (( result != 0 )) && [[ -n "$previous" && "$previous" != "$release" ]]; then
    echo 'Deployment failed; restarting the previous application images. Database backup is retained.' >&2
    previous_compose=(docker compose --project-name astella --project-directory "$previous" \
      --env-file "$env_file" --env-file "$previous/deployment-images.env" \
      -f "$previous/docker-compose.yml" -f "$previous/docker-compose.deploy.yml")
    "${previous_compose[@]}" up -d --no-build --pull never --no-deps --wait --wait-timeout 180 api worker nginx || true
    "${previous_compose[@]}" exec -T nginx nginx -s reload || true
  fi
  exit "$result"
}
trap rollback EXIT
"${compose[@]}" config --quiet

# 拉镜像前先腾地方（2026-10-16）。两次部署（v1.8.9 / v1.8.10）都停在 `pull`：
# `failed to register layer: ... no space left on device`，回滚把上一版重新拉起来（服务没断），
# 但新版本上不去。原因不是"这次镜像特别大"，而是这台机器**从来不清**：旧镜像、构建缓存、
# 旧 release 目录只增不减。部署密钥是强制命令（只接受 `deploy <40位SHA>`），
# 所以清理这件事如果不放在部署路径里，机器上没有任何自动入口可以做。
#
# 只清"没人用"的东西：运行中的容器镜像、数据卷、数据库备份一概不动。
required_free_kb="${REQUIRED_FREE_KB:-5242880}" # 5 GiB，按过去几十次部署的峰值余量取整
free_kb() { df -Pk / | awk 'NR==2 {print $4}'; }
if (( "$(free_kb)" < required_free_kb )); then
  echo "Low disk before pull: $(free_kb) KiB free; pruning unused docker state" >&2
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -af >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  # 旧 release 目录：保留 current 指向的那一个与最近两个（回滚链仍完整）。
  current_release="$(readlink -f /opt/astella/current 2>/dev/null || true)"
  while IFS= read -r stale; do
    [[ -z "$stale" || "$stale" = "$current_release" ]] && continue
    rm -rf "$stale"
  done < <(find /opt/astella/releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +4 | cut -d' ' -f2-)
  echo "After pruning: $(free_kb) KiB free" >&2
fi
if (( "$(free_kb)" < required_free_kb )); then
  echo "Not enough free space to pull this release ($(free_kb) KiB < ${required_free_kb} KiB)." >&2
  echo "Run infra/ops/prune-host-disk.sh on this host, then deploy again." >&2
  exit 1
fi

# Root-only local preflight can use images transferred with docker save/load.
# The forced SSH receiver always uses the registry path.
if [[ ${2:-} != --local-images ]]; then
  "${compose[@]}" pull --quiet postgres role-bootstrap role-grants api migrate worker edge-tts nginx
fi
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 120 postgres edge-tts

# A logical backup precedes every migration, including the first empty database.
mkdir -p /opt/astella/backups
backup="/opt/astella/backups/$(date -u +%Y%m%dT%H%M%S)-$(basename "$release").dump"
# Expanded by the container shell, not the host.
# shellcheck disable=SC2016
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
"${compose[@]}" stop api worker
for service in role-bootstrap migrate role-grants; do
  "${compose[@]}" run --rm --no-deps "$service"
done
"${compose[@]}" up -d --no-build --pull never --no-deps --wait --wait-timeout 180 api worker nginx
# Nginx resolves the API container address when loading its configuration.
# A recreated API may receive another address even if Nginx itself is unchanged.
"${compose[@]}" exec -T nginx nginx -t
"${compose[@]}" exec -T nginx nginx -s reload
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4000/ready >/dev/null
public_host="$(cat /etc/astella/public-host)"
curl --fail --silent --show-error --max-time 15 "https://$public_host/ready" >/dev/null
ln -sfn "$release" /opt/astella/current.next
mv -Tf /opt/astella/current.next /opt/astella/current
trap - EXIT
echo "Deployment healthy: $(basename "$release")"
