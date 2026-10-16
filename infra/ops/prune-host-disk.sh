#!/usr/bin/env bash
# 服务器磁盘清理（2026-10-16）。root 运行。
#
# 为什么需要它：v1.8.9 与 v1.8.10 两次部署都停在 `docker compose pull`——
# `failed to register layer: ... no space left on device`。回滚把上一版镜像重新起来
# （服务没断、数据库备份保留），但新版本上不去。根因是这台机器只增不减：
# 旧镜像、构建缓存、旧 release 目录从来没有清理过。
#
# 部署密钥是强制命令（只接受 `deploy <40位SHA>`，无交互 shell），所以清理只能由
# 服务器管理员在机器上跑一次；`infra/deploy/deploy.sh` 现在会在拉镜像前自动做同一件事
# （见那里的注释），这个脚本用于**手动**把已经堆满的机器先救回来。
#
# 用法（服务器上，root）：bash prune-host-disk.sh
# 可选：KEEP_RELEASES=5 KEEP_BACKUPS=10 bash prune-host-disk.sh
#
# 只动"没人用"的东西：运行中的容器、数据卷、数据库备份以外的任何东西都不碰；
# 最近的 release 与备份都保留。
set -euo pipefail
umask 077

keep_releases="${KEEP_RELEASES:-5}"
keep_backups="${KEEP_BACKUPS:-10}"

echo '== 清理前 =='
df -h / | tail -1
docker system df 2>/dev/null || true

echo "== 旧 release 目录（保留最近 ${keep_releases} 个）=="
current_release="$(readlink -f /opt/astella/current 2>/dev/null || true)"
while IFS= read -r stale; do
  [[ -z "$stale" || "$stale" = "$current_release" ]] && continue
  echo "  rm -rf $stale"
  rm -rf "$stale"
done < <(find /opt/astella/releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +$((keep_releases + 1)) | cut -d' ' -f2-)

echo "== 旧备份（保留最近 ${keep_backups} 份）=="
while IFS= read -r stale_dump; do
  [[ -z "$stale_dump" ]] && continue
  echo "  rm -f $stale_dump"
  rm -f "$stale_dump"
done < <(find /opt/astella/backups -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +$((keep_backups + 1)) | cut -d' ' -f2-)

echo '== 未被使用的容器 / 镜像 / 构建缓存（数据卷不动）=='
docker container prune -f
docker image prune -af
docker builder prune -af

echo '== 清理后 =='
df -h / | tail -1
docker system df 2>/dev/null || true
