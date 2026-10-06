#!/bin/bash
#
# 一次性（可丢弃）开发数据库：为那些**断言依赖"库里只有自己的夹具"**的集成测试
# 重建一个隔离库——全部迁移 + 角色授权都落到一个全新库上，用完即弃。
#
# 为什么需要它：RLS 策略目录（rls-policies-postgres）、worker 队列
# （queue-postgres）、投影分页（projection-pagination）等用例，断言里含
# "claim 到的恰好是这两条 job""库里没有别的 active queue"这类前提。在共享的
# 开发库（astella）上跑会因为历史残留行而**假失败**；反过来它们又会写入和删除
# 数据，本来也不该在开发库上跑。CI 是每次起一个空的 postgres 服务来解决这个
# 问题的，本地没有等价物——这个脚本就是那个等价物。
#
# 用法：
#   bash scripts/dev-disposable-db.sh                    # 默认 astella_rls_test
#   bash scripts/dev-disposable-db.sh astella_scratch
#   make disposable-db DISPOSABLE_DB=astella_scratch
#
# 前置：开发 compose 的 postgres 容器在跑（`make up` 或 `make storage` 之后）。
# 连接串默认打 127.0.0.1:${DISPOSABLE_DB_PORT:-5432}（compose 的宿主端口映射），
# 可用 DISPOSABLE_DB_HOST / DISPOSABLE_DB_PORT 覆盖。
#
# 安全性（这是把删除操作放进仓库的前提）：目标库名必须匹配 astella_* 且
# **不等于** astella / postgres，否则直接拒绝执行——开发库不会被误删。
#
# 跑完会打印可直接复制的集成测试环境变量。示例（apps/api 下）：
#   RLS_TEST_MIGRATOR_DATABASE_URL=... \
#   RLS_TEST_API_DATABASE_URL=... \
#   RLS_TEST_WORKER_DATABASE_URL=... \
#   node --import tsx --test src/integration-tests/rls-policies-postgres.integration.ts

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 先把「调用方显式给的值」固定进私有变量，**再** source .env。
# .env 里有 PORT=4000（API 端口）这类通用名：此前用短别名 PORT 承接数据库端口，
# source 之后被 .env 覆盖成 4000，迁移于是去连 127.0.0.1:4000——API 恰好监听在那里，
# TCP 连得上但 Postgres 握手永远不来，脚本无声挂死。位置参数 $1 不受 source 影响。
ARG_DB_NAME="${1:-}"
REQUESTED_HOST="${DISPOSABLE_DB_HOST:-}"
REQUESTED_PORT="${DISPOSABLE_DB_PORT:-}"

DB_NAME="${ARG_DB_NAME:-astella_rls_test}"
COMPOSE=(docker compose -p astella-dev -f docker-compose.dev.yml)

# ── 安全护栏：只允许删/建一次性库 ────────────────────────────────────────
case "$DB_NAME" in
  astella|postgres|template0|template1|"")
    echo "refusing to use protected database '$DB_NAME' as a disposable database" >&2
    exit 2
    ;;
esac
if ! printf '%s' "$DB_NAME" | grep -Eq '^astella_[A-Za-z0-9_]+$'; then
  echo "disposable database name must match ^astella_[A-Za-z0-9_]+\$ (got '$DB_NAME')" >&2
  exit 2
fi

# ── 凭据：与 dev compose 同一份 .env（apply-roles.sh 也是从这里拿密码）────
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "missing $REPO_ROOT/.env (needed for POSTGRES_USER/POSTGRES_PASSWORD and the role passwords)" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a
: "${POSTGRES_USER:?POSTGRES_USER is required in .env}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required in .env}"
: "${MIGRATOR_PASSWORD:?MIGRATOR_PASSWORD is required in .env}"
: "${API_PASSWORD:?API_PASSWORD is required in .env}"
: "${WORKER_PASSWORD:?WORKER_PASSWORD is required in .env}"

# source 之后再定连接地址（见文件上方关于 PORT 被 .env 覆盖的说明）。
DB_HOST="${REQUESTED_HOST:-127.0.0.1}"
DB_PORT="${REQUESTED_PORT:-5432}"

# ── 连库方式：daemon 可达即可，不依赖 docker CLI ────────────────────────────
# 为什么改：docker CLI 不在 PATH 的机器上（daemon 在跑、127.0.0.1:5432 可达）
# 本脚本会直接拒绝，于是真库集测只能落**共享 dev 库**——而那一族判据的前提是
# 「库里只有自己的夹具」，不满足时制卡那几份会报**假失败**（"worker must process
# outbox jobs (got 0)"／"生成并发已达上限"），症状完全不像环境问题。
# 一次性库纪律是那批判据的地基，所以这里让它不再依赖 CLI。
PG_CONTAINER=""
if command -v docker >/dev/null 2>&1; then
  PG_CONTAINER="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
fi

psql_admin() { # psql_admin <dbname> [extra psql args...]
  local db="$1"; shift
  if [ -n "$PG_CONTAINER" ]; then
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$PG_CONTAINER" \
      psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" "$@"
    return $?
  fi
  # 退回直连 + 极小的 psql 替身（用仓库自己的 pg 驱动，不装任何新东西）。
  # **ON_ERROR_STOP=1 的等价物**：替身自己在任何一条语句失败时以非零退出。
  PGPASSWORD="$POSTGRES_PASSWORD" node "$REPO_ROOT/scripts/psql-lite.mjs" \
    -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d "$db" "$@"
}

if [ -z "$PG_CONTAINER" ]; then
  # 连不上就在这里停。**不能让失败延后到每一条命令各自报一次**：
  # 那种报错离病因有三层（CLI 缺失 / 端口 / 密码），而症状最终会表现成
  # "worker must process outbox jobs (got 0)"——那离病因隔了整整一层台账。
  if ! PGPASSWORD="$POSTGRES_PASSWORD" node "$REPO_ROOT/scripts/psql-lite.mjs" \
       -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d postgres \
       -q -t -A -c 'SELECT 1' >/dev/null 2>&1; then
    echo "cannot reach postgres at $DB_HOST:$DB_PORT as \"$POSTGRES_USER\"." >&2
    echo "The container path is unavailable (docker CLI not on PATH) and the direct" >&2
    echo "connection failed. Fix that before anything else: otherwise every later" >&2
    echo "failure shows up as 'worker must process outbox jobs (got 0)'." >&2
    exit 2
  fi
fi

apply_roles() { # apply_roles <dbname> <true|false>
  psql_admin "$1" \
    -v migrator_password="$MIGRATOR_PASSWORD" \
    -v api_password="$API_PASSWORD" \
    -v worker_password="$WORKER_PASSWORD" \
    -v require_rls_disabled="$2" \
    -f - < "$REPO_ROOT/infra/postgres/roles.sql" >/dev/null
}

echo "==> recreating disposable database $DB_NAME"
psql_admin postgres \
  -c "DROP DATABASE IF EXISTS $DB_NAME" \
  -c "CREATE DATABASE $DB_NAME OWNER $POSTGRES_USER"

# 角色是集群级的（已存在则跳过创建、按 .env 轮换密码）；这里只负责把
# 库级授权与 DEFAULT PRIVILEGES 落到新库上——迁移前先来一遍，迁移后再来一遍
# 兜住迁移新建的表（与 CI 的 fresh-migrations job 同序）。
echo "==> applying role grants (pre-migration)"
apply_roles "$DB_NAME" false

DATABASE_URL_DISPOSABLE="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo "==> running migrations"
# 迁移会把 223 条迁移名逐条打出来；成功时只留最后一行，失败时原样全量输出
# （诊断信息不能省，但成功路径不该刷屏）。
if ! migrate_output="$(
  cd "$REPO_ROOT/apps/api"
  DATABASE_URL_MIGRATOR="$DATABASE_URL_DISPOSABLE" \
  DATABASE_URL="$DATABASE_URL_DISPOSABLE" \
    npm run --silent db:migrate 2>&1
)"; then
  printf '%s\n' "$migrate_output" >&2
  echo "migrations failed against $DB_NAME (database left in place for inspection)" >&2
  exit 1
fi
printf '    %s\n' "$(printf '%s\n' "$migrate_output" | tail -n 1)"

echo "==> applying role grants (post-migration) + RLS completeness check"
apply_roles "$DB_NAME" true

MIGRATOR_URL="postgres://astella_migrator:$MIGRATOR_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
API_URL="postgres://astella_api:$API_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
WORKER_URL="postgres://astella_worker:$WORKER_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"

cat <<EOF

$DB_NAME is ready (all migrations applied, role grants applied, RLS catalog complete).

  RLS/SEC-01 + 受限角色用例（apps/api）:
    RLS_TEST_MIGRATOR_DATABASE_URL='$MIGRATOR_URL' \\
    RLS_TEST_API_DATABASE_URL='$API_URL' \\
    RLS_TEST_WORKER_DATABASE_URL='$WORKER_URL' \\
    node --import tsx --test src/integration-tests/rls-policies-postgres.integration.ts

  worker 队列用例（workers/ai-worker）:
    QUEUE_TEST_MIGRATOR_DATABASE_URL='$MIGRATOR_URL' \\
    QUEUE_TEST_WORKER_A_DATABASE_URL='$WORKER_URL' \\
    QUEUE_TEST_WORKER_B_DATABASE_URL='$WORKER_URL' \\
    node --import tsx --test src/integration-tests/queue-postgres.integration.ts

  需要超级用户连接的用例（投影分页、拓扑等，夹具自己写数据）:
    DATABASE_URL='$DATABASE_URL_DISPOSABLE' \\
    DATABASE_URL_API='$DATABASE_URL_DISPOSABLE' \\
    DATABASE_URL_MIGRATOR='$DATABASE_URL_DISPOSABLE' \\
    DATABASE_URL_WORKER='$DATABASE_URL_DISPOSABLE'

  注意 DATABASE_URL 不是多余的：多数用例经 packages/shared 的
  integration-test-db-env 读的是它，缺了它会以
  「集成测试缺少 DATABASE_URL」直接失败——只设 API/MIGRATOR/WORKER 三个
  变量会在 60 个用例上白跑一遍（实测 2026-09-27）。

注意：这些用例会往库里写夹具并做清理，但**不要**把这个库当成长期状态；
任何一次运行后都可直接重跑本脚本回到干净状态。
EOF
