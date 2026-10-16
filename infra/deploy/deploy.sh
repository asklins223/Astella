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

# 每次部署、拉镜像前都清一次（2026-10-16）。两次部署（v1.8.9 / v1.8.10）都停在 `pull`：
# `failed to register layer: ... no space left on device`，回滚把上一版重新拉起来（服务没断），
# 但新版本上不去。根因不是"这次镜像特别大"，而是这台机器**从来没清过**——实测清零前
# 84 个镜像 23.77 GB（其中 22.28 GB 可回收）、40 个旧 release 目录、44 份备份。
# 部署密钥是强制命令（只接受 `deploy <40位SHA>`），机器上没有别的自动入口，所以清理必须在这里。
#
# 清什么：已停容器、**没有被任何容器引用**的镜像、构建缓存、除 current 与最近两个之外的旧 release。
# 不清什么：数据卷与运行中容器用的镜像——`image prune -a` 不会碰在用的镜像，所以回滚目标
# （current 指向、正在运行的那一版）始终完好。放在 **pull 之前**而不是部署成功之后：
# 事后清会把上一版的镜像也删掉，那时回滚就没得回了。
required_free_kb="${REQUIRED_FREE_KB:-5242880}" # 5 GiB：低于这个数就拒绝部署并说清原因
free_kb() { df -Pk / | awk 'NR==2 {print $4}'; }
echo "Disk before deploy: $(free_kb) KiB free; pruning unused docker state" >&2
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
echo "Disk after pruning: $(free_kb) KiB free" >&2
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
