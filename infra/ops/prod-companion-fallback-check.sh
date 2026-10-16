#!/bin/bash
# 生产那一次「换模型重说」的实测（2026-10-16，②的最后一块）。
#
# 为什么要写成脚本：`companion_fallback` 槽配没配上，看代码看不出来——它由
# `config/ai-platforms.json`（随 tag 的部署 bundle 落地）+ `production.env` 里的
# `SILICONFLOW_API_KEY` 两处一起决定，任一处缺了就静默退回"没配"，而降级链照旧零执行。
# 只有把探针放进 worker 容器跑一次，才能同时看到两件事：解析到了哪个平台/模型、
# 以及那句退化正文的第二轮是不是真由**另一个模型**答的。
#
# 用法（服务器上，root）：
#   bash prod-companion-fallback-check.sh <workspaceId> <userId>
# 两个 id 的取法也写在下面第一条查询里（他的生产账号是 asklins@gmail.com）。
#
# 反面对照在探针内部：把兜底槽撤掉，同一份输入必须一次调用都不花。
set -euo pipefail

WS="${1:?用法：prod-companion-fallback-check.sh <workspaceId> <userId>}"
USER_ID="${2:?用法：prod-companion-fallback-check.sh <workspaceId> <userId>}"

echo "== 跑的是哪一版 =="
readlink -f /opt/astella/current
echo -n "配置里有 companion_fallback 槽: "
docker exec astella-worker-1 grep -c companion_fallback /app/config/ai-platforms.json
echo -n "worker 进程拿得到 SILICONFLOW key: "
docker exec astella-worker-1 sh -c 'tr "\0" "\n" < /proc/1/environ | grep -c "^SILICONFLOW_API_KEY="'

HANDLERS=$(docker exec astella-worker-1 sh -c 'ls -d /app/src/handlers 2>/dev/null || ls -d /app/workers/ai-worker/src/handlers')
echo -n "真因日志（companion agent failure cause）在跑: "
docker exec astella-worker-1 grep -c 'companion agent failure cause' "$HANDLERS/companion-dialogue.ts"
echo -n "失败留档点名（这一轮已经做成的操作仍然保留）在跑: "
docker exec astella-worker-1 grep -c '这一轮已经做成的操作仍然保留' "$HANDLERS/companion-dialogue-failure-retention.ts"

echo "== 降级链实测（dev 已 PASS，这一趟是生产）=="
# 部署 bundle 里只有 config/infra/compose，没有源码树，所以探针要自己带上去：
#   本地：base64 -i workers/ai-worker/scripts/companion-fallback-chain-probe.ts | pbcopy
#   服务器：echo '<那串>' | base64 -d > /tmp/companion-fallback-chain-probe.ts
PROBE="${PROBE_FILE:-$(find /opt/astella/releases -path '*companion-fallback-chain-probe.ts' 2>/dev/null | head -1)}"
if [ -z "$PROBE" ] || [ ! -f "$PROBE" ]; then
  echo "没找到探针文件。要么把它拷到服务器后带上来：PROBE_FILE=/tmp/companion-fallback-chain-probe.ts bash $0 $WS $USER_ID"
  exit 1
fi
docker cp "$PROBE" astella-worker-1:/app/scripts/companion-fallback-chain-probe.ts
docker exec -w /app astella-worker-1 ./node_modules/.bin/tsx \
  scripts/companion-fallback-chain-probe.ts "$WS" "$USER_ID"
docker exec astella-worker-1 rm -f /app/scripts/companion-fallback-chain-probe.ts

echo "== 主动消息有没有签出语音段（⑤最后一条的读数）=="
docker exec astella-postgres-1 psql -U astella -d astella -Atc "
select to_char(r.created_at,'MM-DD HH24:MI') at, coalesce(r.input_source->>'kind','?') kind, r.status,
  coalesce(r.error_code,'-') err,
  (select count(*) from companion_stream_events e where e.run_id=r.id and e.type='voice.segment.ready') segs
from companion_turn_runs r where r.created_at > now() - interval '3 days'
order by r.created_at desc limit 15"
