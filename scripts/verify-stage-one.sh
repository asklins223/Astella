#!/bin/bash
#
# 阶段一门槛跑批：起一个一次性库，把 39d 台账里点名的集成档一次跑完，
# 并按「组 / 用例数 / 通过 / 失败 / 耗时」出一张表。
#
# 为什么需要它：39d 台账里反复出现「隔离 PostgreSQL 端到端 N/N」这类证据，
# 但每次验收都要人肉重做同一件事——起一次性库、导迁移、把四个 DATABASE_URL_*
# 变量拼对、逐个 npm script 跑、再从 TAP 输出里数 pass/fail。这一步既慢又容易
# 少设一个变量（只设 API/MIGRATOR/WORKER 而漏 DATABASE_URL，会让 60 个用例
# 以「集成测试缺少 DATABASE_URL」集体失败，看上去像代码坏了，其实是环境没配）。
# 三个会话并行时更不能各起各的库互相踩。
#
# 这个脚本**不判定任何 §16 案例是否通过**。它只报告"某组用例是绿是红"。
# 案例与 W 项的归属、以及"绿了也不等于该案例已达"的理由，都在
# docs/plans/learning-companion/39d-stage-one-gate-runner.md 里，由负责那一项
# 的人维护。把"测试绿"直接写成"验收通过"正是 39d 台账反复纠正过的错误。
#
# 用法：
#   bash scripts/verify-stage-one.sh                  # 全部组（复用一个已就绪的库）
#   bash scripts/verify-stage-one.sh rounds disputes # 只跑指定组
#   bash scripts/verify-stage-one.sh --fresh all      # 先重建库再跑
#   bash scripts/verify-stage-one.sh --list           # 只列组，不跑
#
# 前置：开发 compose 的 postgres 容器在跑（make up / make storage 之后），
# 且 PATH 上有 docker 与 node（homebrew 在 /opt/homebrew/bin，Docker 在
# /usr/local/bin；非登录 shell 的 PATH 通常两个都没有，脚本自己会补）。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── PATH：非登录 shell 里 homebrew 与 docker 都不在 PATH 上 ────────────────
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
done
export PATH
command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker not found on PATH" >&2; exit 2; }

DB_NAME="${STAGE_ONE_DB:-ailearn_stage1_gate}"

# ── 组 → 集成档。名字与 apps/api、workers/ai-worker 的 npm script 对齐 ────
# 注意：数组**不能**叫 GROUPS——那是 bash 的特殊变量（当前用户的组 ID），
# 赋值会被忽略，循环会遍历到一串数字。踩过一次。
GATE_GROUPS=(
  "objectives:学习目标身份/快照/证据:W5-2 §16.21 §16.26"
  "rounds:笔记学习旅程与轮次:W4-2/3/5/6/8 §16.1 §16.2 §16.3 §16.4 §16.9 §16.10 §16.14 §16.17 §16.23"
  "disputes:争议/排期/提醒闸:W5-5 §16.11 §16.22 §16.24 §16.25"
  "runs:学习轮次与指标:W4-8 §16.19 §16.21"
  "cards:制卡运行与保存:§16.35"
  "perimeter:权限/RLS/隔离:W5-6 §16.13 §16.20"
  "companion:伴星对话与动作:W2-3 §16.29 §16.30 §16.32 §16.39"
)

api_script_for() { # 组名 → apps/api 的 npm script（空格分隔＝这一组跑几档）
  case "$1" in
    objectives) echo "test:objective-governance:postgres" ;;
    rounds)     echo "test:learning-rounds:postgres" ;;
    disputes)   echo "test:assessment-disputes:postgres test:dispute-read-side:postgres" ;;
    runs)       echo "test:learning-runs:postgres" ;;
    perimeter)  echo "test:route-contract:postgres test:review-schedule-boundary:postgres" ;;
    companion)  echo "test:companion-integration:postgres" ;;
    *)          echo "" ;;
  esac
}
worker_script_for() { # 组名 → workers/ai-worker 的 npm script
  case "$1" in
    cards)     echo "test:card-generation-v3:postgres" ;;
    companion) echo "test:companion-integration:postgres" ;;
    *)         echo "" ;;
  esac
}

group_exists() {
  local want="$1" g name
  for g in "${GATE_GROUPS[@]}"; do
    name="${g%%:*}"
    [ "$name" = "$want" ] && return 0
  done
  return 1
}

# ── 参数 ────────────────────────────────────────────────────────────────────
FRESH=0
LIST_ONLY=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --list)  LIST_ONLY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *)
      if group_exists "$arg" || [ "$arg" = "all" ]; then SELECTED+=("$arg")
      else echo "unknown group '$arg' (try --list)" >&2; exit 2; fi
      ;;
  esac
done
[ ${#SELECTED[@]} -eq 0 ] && SELECTED=(all)

if [ "$LIST_ONLY" = 1 ]; then
  printf '%-12s %-22s %s\n' "GROUP" "COVERS" "SUITES"
  for g in "${GATE_GROUPS[@]}"; do
    name="${g%%:*}"; rest="${g#*:}"; covers="${rest%%:*}"
    printf '%-12s %-22s api=%s worker=%s\n' "$name" "$covers" \
      "$(api_script_for "$name")" "$(worker_script_for "$name")"
  done
  exit 0
fi

want_all=0
for s in "${SELECTED[@]}"; do [ "$s" = "all" ] && want_all=1; done

# ── 一次性库 ────────────────────────────────────────────────────────────────
# 已就绪就复用：重建要导 223 条迁移，每次几十秒起步，而同一轮验收通常要跑好几组。
if [ "$FRESH" = 1 ]; then
  echo "==> --fresh：重建 $DB_NAME"
  bash scripts/dev-disposable-db.sh "$DB_NAME" >/dev/null 2>&1 || {
    echo "disposable db provisioning failed; run: bash scripts/dev-disposable-db.sh $DB_NAME" >&2
    exit 1
  }
else
  if ! docker exec -i ailearn-dev-postgres-1 psql -q -t -U ailearn -d postgres \
        -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
    echo "==> $DB_NAME 不存在，先建一个"
    bash scripts/dev-disposable-db.sh "$DB_NAME" >/dev/null 2>&1 || {
      echo "disposable db provisioning failed" >&2; exit 1
    }
  else
    echo "==> 复用已就绪的 $DB_NAME（--fresh 可强制重建）"
  fi
fi

CONN="postgres://ailearn:ailearn_dev@127.0.0.1:${DISPOSABLE_DB_PORT:-5432}/$DB_NAME"
ROLE_CONN="postgres://ailearn_%s:ailearn_dev@127.0.0.1:${DISPOSABLE_DB_PORT:-5432}/$DB_NAME"
# **四个变量不能全指超户**。夹具写走超户（`DATABASE_URL` / `DATABASE_URL_MIGRATOR`），
# 但被测路径要跑在**受限角色**上（`DATABASE_URL_API` / `DATABASE_URL_WORKER`）：
# 把它们也指成超户，RLS 那一族用例会集体"通过"——因为 RLS 根本没生效。
# 那是比红更坏的结果，所以这里逐个分开设。
export DATABASE_URL="$CONN"
export DATABASE_URL_MIGRATOR="$CONN"
export DATABASE_URL_API="$(printf "$ROLE_CONN" api)"
export DATABASE_URL_WORKER="$(printf "$ROLE_CONN" worker)"
export RLS_TEST_MIGRATOR_DATABASE_URL="$(printf "$ROLE_CONN" migrator)"
export RLS_TEST_API_DATABASE_URL="$(printf "$ROLE_CONN" api)"
export RLS_TEST_WORKER_DATABASE_URL="$(printf "$ROLE_CONN" worker)"
export QUEUE_TEST_MIGRATOR_DATABASE_URL="$(printf "$ROLE_CONN" migrator)"
export QUEUE_TEST_WORKER_A_DATABASE_URL="$(printf "$ROLE_CONN" worker)"
export QUEUE_TEST_WORKER_B_DATABASE_URL="$(printf "$ROLE_CONN" worker)"
export CI=1

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stage-one-gate-XXXXXX")"
trap 'rm -rf "$LOG_DIR"' EXIT

TOTAL_PASS=0; TOTAL_FAIL=0; FAILED_GROUPS=()
printf '\n%-12s %-8s %-8s %-8s\n' "GROUP" "PASS" "FAIL" "SECONDS"
printf '%s\n' "------------------------------------------------------------"

run_suite() { # run_suite <log-label> <dir> <npm-script>
  local label="$1" dir="$2" script="$3" log="$LOG_DIR/$1.log"
  local out start end pass fail
  start=$(date +%s)
  ( cd "$dir" && npm run --silent "$script" ) >"$log" 2>&1
  end=$(date +%s)
  # TAP 汇总行：最后一次出现的 "# pass N" / "# fail N"
  pass=$(grep -E '^# pass [0-9]+$' "$log" | tail -1 | awk '{print $3}')
  fail=$(grep -E '^# fail [0-9]+$' "$log" | tail -1 | awk '{print $3}')
  pass="${pass:-0}"; fail="${fail:-0}"
  printf '%-12s %-8s %-8s %-8s\n' "$label" "$pass" "$fail" "$((end - start))"
  TOTAL_PASS=$((TOTAL_PASS + pass)); TOTAL_FAIL=$((TOTAL_FAIL + fail))
  [ "$fail" -gt 0 ] && { FAILED_GROUPS+=("$label"); echo "    -> $log"; }
  return 0
}

for g in "${GATE_GROUPS[@]}"; do
  name="${g%%:*}"
  [ "$want_all" = 1 ] || { keep=0; for s in "${SELECTED[@]}"; do [ "$s" = "$name" ] && keep=1; done; [ "$keep" = 1 ] || continue; }
  script="$(api_script_for "$name")"
  for one in $script; do
    [ -n "$one" ] && run_suite "$name" "$REPO_ROOT/apps/api" "$one"
  done
  script="$(worker_script_for "$name")"
  for one in $script; do
    [ -n "$one" ] && run_suite "$name/w" "$REPO_ROOT/workers/ai-worker" "$one"
  done
done

printf '%s\n' "------------------------------------------------------------"
printf 'TOTAL pass=%s fail=%s\n' "$TOTAL_PASS" "$TOTAL_FAIL"
if [ ${#FAILED_GROUPS[@]} -gt 0 ]; then
  printf 'failing: %s\n' "${FAILED_GROUPS[*]}"
  echo
  echo "提醒：红的用例只说明这一组没过。写进 39d 台账时仍要区分"
  echo "「实现缺失」「用例本身钉了旧链路」「环境/夹具问题」三种原因——"
  echo "台账里 C31/C16 那几行记的就是第三类：断言钉了已经删掉的旧链，"
  echo "红得跟新功能没关系。"
  exit 1
fi
echo "全绿。这仍然不等于任何 §16 案例已验收——见 docs/plans/learning-companion/39d-stage-one-gate-runner.md"
