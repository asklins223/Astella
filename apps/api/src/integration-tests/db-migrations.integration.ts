/**
 * DB 连通性与迁移状态集成测试（当前核心表存在 + 退役数据结构不会复活）。
 *
 * 验证方案 57 之后的笔记学习卡链路在真实 Postgres 中存在，且已退役的
 * 学习轮次 / 复习 / 旧制卡表不会被 fresh migration 重新创建。
 *
 * 环境：DATABASE_URL_API / DATABASE_URL（compose postgres）。
 * 跳过条件：无 DB 可达时 skip（CI 无 DB 时测试不失败，避免误报）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
/** 方案 57：一张笔记一套学习卡，卡挂在笔记版本上。 */
const REQUIRED_TABLES = [
  "note_learning_cards",
  "note_learning_card_questions",
  "note_learning_card_attempts",
];
const RETIRED_TABLES = [
  "learning_sessions",
  "learning_episodes",
  "legacy_route_mappings_v2",
  "learning_session_probes",
  "learning_response_artifacts",
  "learning_assessment_reports",
  "learning_tutor_detours",
  "learning_tutor_permissions",
  "learning_tutor_action_nonces",
  "assistant_thoughts",
  // 方案 57 删掉的旧链路：学习运行、轮次、复习与旧制卡。
  "learning_runs",
  "note_learning_rounds",
  "learning_cards",
  "learning_cards_v2",
  "review_schedules",
  // 2026-10-20：0449 用 CASCADE 删掉 note_learning_rounds 后，这张表只剩
  // RLS 开着、没有策略，全新库引导自检直接 RAISE；它已没有读者，0450 一并退役。
  "note_learning_reflections",
];
const RETIRED_FUNCTIONS = ["astella_enqueue_companion_thoughts"];

test("学习卡核心表存在且退役表与调度函数已删除", async (t) => {
  if (!CONN) {
    t.skip("DATABASE_URL_API 未配置——跳过 DB 集成测试");
    return;
  }
  const pool = new Pool({ connectionString: CONN, connectionTimeoutMillis: 5_000 });
  try {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.' || table_name) AS regclass
       FROM (VALUES ${REQUIRED_TABLES.map((_, i) => `($${i + 1})`).join(",")}) AS t(table_name)`,
      REQUIRED_TABLES,
    );
    const missing = rows
      .map((r) => (r as { regclass?: string | null }).regclass ?? null)
      .filter((r: string | null) => r === null);
    assert.deepEqual(missing, [], `迁移未应用：缺表 ${REQUIRED_TABLES.filter((_, i) => rows[i]?.regclass === null).join(", ")}`);
    const retired = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [RETIRED_TABLES],
    );
    assert.deepEqual(retired.rows, [], `退役表仍存在：${retired.rows.map((row) => row.table_name).join(", ")}`);
    const retiredFunctions = await pool.query(
      `SELECT p.proname AS function_name
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [RETIRED_FUNCTIONS],
    );
    assert.deepEqual(
      retiredFunctions.rows,
      [],
      `退役调度函数仍存在：${retiredFunctions.rows.map((row) => row.function_name).join(", ")}`,
    );
  } finally {
    await pool.end();
  }
});

test("学习卡表列存在", async (t) => {
  if (!CONN) {
    t.skip("DATABASE_URL_API 未配置——跳过 DB 集成测试");
    return;
  }
  const pool = new Pool({ connectionString: CONN, connectionTimeoutMillis: 5_000 });
  try {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='note_learning_cards'`,
    );
    const cols = new Set(
      rows.map((r) => (r as { column_name?: string }).column_name ?? ""),
    );
    for (const required of ["id", "workspace_id", "note_id", "note_version_id", "status"]) {
      assert.ok(cols.has(required), `note_learning_cards 缺列 ${required}`);
    }
  } finally {
    await pool.end();
  }
});
