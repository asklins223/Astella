#!/bin/bash
# 主模型换 mimo 后的端到端验证（2026-10-15）。
#
# 用户决定：主模型 agent_turn → mimo / mimo-v2.6-flash（openai_compatible）。
#
# 这条链现在验什么（与 10-14 旧版判据的差别写在下面，因为判据变了）：
#   旧判据①「用户轮必须落 reasoning 明文」在 mimo 上**不成立**——
#   `OpenAICompatibleProvider.executeAgentTurn` 不提取上游的 `reasoning_content`
#   （实测上游给了、provider 丢掉），且 mimo **没有**那条
#   「reasoning_text must be passed back」契约（危险形状实测 OK）。
#   所以 mimo 上思考**默认**就保住，不需要明文链；把"必须落明文"当判据会假红。
#   明文状态降为**记录项**：opencode-go 主模型时才该有值。
#
# 现在的判据（两条同时成立才算过）：
#   1. 用户轮 run=succeeded（主模型 mimo 真跑通了）
#   2. 主动轮 run=succeeded **且**全程无 "thinking disabled"（思考没被降级）
#
# 任一步不达就非零退出并打印卡在哪一步，不假装成功。
set -u
WS=e5483fe4-13d1-4725-811e-473ae8258cea
UID_=da64bbce-1781-4753-8648-c7cb811caaa0
CID=9404b494-e7bc-4bdd-a58b-f5e61a23b309
API=http://127.0.0.1:4000
PSQL="docker exec astella-dev-postgres-1 psql -U astella -d astella -t -A -c"
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
cleanup(){ $PSQL "DELETE FROM sessions WHERE token='$HASH';
  DELETE FROM companion_awareness_sessions WHERE device_session_id='desktop:e2e-boot';
  DELETE FROM companion_awareness_observations WHERE dedupe_key LIKE 'reply:e2e-boot%';" >/dev/null; }

# ── 1. 主模型健康（mimo；最多等 15 分钟）────────────────────────────────
log "等主模型(mimo)就绪…（最多 15 分钟）"
healthy=0
for i in $(seq 1 30); do
  out=$(docker exec astella-dev-worker-1 ./node_modules/.bin/tsx scripts/probe-gateway-health.ts "$WS" "$UID_" 2>&1 | grep -a "^\[health\]")
  if grep -q "OK" <<<"$out"; then healthy=1; log "主模型就绪：$out"; break; fi
  log "第 $i 次：$out"
  sleep 30
done
if [ "${healthy}" != "1" ]; then log "FAIL@主模型：15 分钟未就绪"; exit 2; fi

# ── 2. 铸会话、发真实用户轮 ────────────────────────────────────────────
HASH=$(printf '%s' "e2e-boot-$(date +%s)" | shasum -a 256 | cut -d' ' -f1)
TOKEN="e2e-boot-$(date +%s)"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
$PSQL "INSERT INTO sessions(token,user_id,workspace_id,expires_at,client_kind) VALUES ('$HASH','$UID_','$WS', now()+interval '2 hours','desktop');" >/dev/null
CMID=$(uuidgen | tr 'A-Z' 'a-z'); IKEY=$(uuidgen | tr 'A-Z' 'a-z')
log "发用户轮（主模型 mimo）…"
resp=$(curl -s -m 60 -X POST "$API/companion/conversations/$CID/turns" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $IKEY" \
  -d "{\"version\":1,\"clientMessageId\":\"$CMID\",\"inputKind\":\"text\",\"sourceSurface\":\"pet\",\"blocks\":[{\"type\":\"text\",\"text\":\"用一句话鼓励我学习。\"}]}")
RUN1=$(grep -o '"runId":"[0-9a-f-]*"' <<<"$resp" | head -1 | cut -d'"' -f4)
if [ -z "$RUN1" ]; then log "FAIL@发轮：$resp"; exit 3; fi
log "用户轮 run=$RUN1"

# ── 3. 等用户轮落地（最多 17 分钟）─────────────────────────────────────
st=""
for i in $(seq 1 68); do
  st=$($PSQL "SELECT status FROM companion_turn_runs WHERE id='$RUN1';")
  if [ "$st" != "running" ] && [ "$st" != "accepted" ]; then break; fi
  sleep 15
done
if [ "$st" != "succeeded" ]; then log "FAIL@用户轮：status=${st}（主模型没跑通）"; exit 4; fi
log "判据一通过：用户轮 succeeded"

# 记录项（不作判据）：mimo 不提取 reasoning，这里是 NULL 属预期；opencode-go 主模型时才该有值。
rs=$($PSQL "SELECT coalesce(jsonb_typeof(m.reasoning),'NULL') FROM companion_messages m
  JOIN companion_turn_runs r ON r.assistant_message_id=m.id WHERE r.id='$RUN1';")
log "记录（非判据）：reasoning 列 = ${rs}（mimo 预期 NULL）"

# ── 4. 触发主动轮（危险形状：以 assistant 收尾 + 带工具 + 思考开）────────
$PSQL "INSERT INTO companion_awareness_sessions(workspace_id,user_id,device_session_id,app_launch_id,host,context,observed_at,updated_at)
 VALUES('$WS','$UID_','desktop:e2e-boot',gen_random_uuid(),'desktop',
  '{\"foreground\":true,\"unlocked\":true,\"learning\":false,\"typing\":false,\"speaking\":false,\"participationAllowed\":true}'::jsonb, now(), now())
 ON CONFLICT (workspace_id,user_id,device_session_id) DO UPDATE SET context=EXCLUDED.context, updated_at=now(), observed_at=now();" >/dev/null
OID=$(uuidgen | tr 'A-Z' 'a-z')
$PSQL "INSERT INTO companion_awareness_observations (id,workspace_id,user_id,dedupe_key,topic,device_session_id,conversation_id,facts,expires_at)
 VALUES ('$OID','$WS','$UID_','reply:e2e-boot-$OID','reply.finished','desktop:e2e-boot','$CID','{\"messageIds\":[]}'::jsonb, now()+interval '5 minutes');" >/dev/null
$PSQL "INSERT INTO jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,scheduled_at,idempotency_key)
 VALUES ('companion_initiative','$WS','$UID_', json_build_object('observationId','$OID')::jsonb,'pending',25,'maintenance',now(),'companion-awareness:$OID');" >/dev/null
log "主动轮已入队"

# ── 5. 等主动轮落地 ────────────────────────────────────────────────────
st2=""
for i in $(seq 1 40); do
  st2=$($PSQL "SELECT r.status FROM companion_turn_runs r
    WHERE r.created_at > now()-interval '6 minutes' AND r.input_source->>'kind'='initiative'
    ORDER BY r.created_at DESC LIMIT 1;")
  if [ -n "$st2" ] && [ "$st2" != "running" ] && [ "$st2" != "accepted" ]; then break; fi
  sleep 15
done
log "主动轮状态=${st2}"

if [ "${st2}" != "succeeded" ]; then log "FAIL@主动轮：status=${st2}（危险形状被拒）"; exit 5; fi
log "判据二通过：主动轮 succeeded（危险形状没被拒）"

guard=$(docker logs astella-dev-worker-1 --since 30m 2>&1 | grep -c "thinking disabled" || true)
log "thinking disabled 出现次数=${guard}"
if [ "${guard:-0}" != "0" ]; then log "FAIL@守卫：思考被降级 ${guard} 次"; exit 6; fi
log "判据三通过：全程无降级，思考保住了"

cleanup
log "PASS：主模型 mimo 端到端两条判据成立"
