/**
 * 本人关系确认那张表**不许**有"表现类"列（39d W5-6 刀七；39 §11.3）。
 *
 * §11.3 的原话是「关系修改**不伪造过去的学习事实**」。确认一条关系**不是**一次学习表现——
 * 它是本人对一条既有建议的判断。如果这张表里出现 `observedCount` / `performanceScore` /
 * `lastReviewedAt` 那一类列，读侧迟早会把"我确认过这条关系"画成"我在这条关系上练过"。
 *
 * 为什么是一条**列名**守卫而不是一条 CHECK：
 * 迁移里我先写过一版 `CONSTRAINT prd_v2_no_performance_columns_chk CHECK (true)`，
 * 读起来像守卫、实际什么都不拦——`CHECK (true)` 恒真。加列的人会以为已经拦住了。
 * 那种"看起来有防护其实没有"的东西比不写更糟，所以删掉 CHECK，改成这条能真拦的测试。
 *
 * 判据是**子串**匹配而不是全表枚举：新增一个含 `score`／`count`／`perform`／
 * `reviewed`／`mastery` 的列就红。宁可误报（起个中性名字改一下）也不要漏——
 * 漏的代价是 §11.3 那一句话在半年后悄悄失效。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

// `import.meta.dirname` = `packages/shared/src`。schema 在同包的 `src/db-schema/` 下，
// 迁移要往上三級到仓库根（src → shared → packages → 仓库根）。
const SCHEMA_FILE = resolve(
  import.meta.dirname,
  "db-schema",
  "personal-relation-decisions.ts",
);
const MIGRATION_FILE = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "apps",
  "api",
  "src",
  "db",
  "migrations",
  "0302_personal_relation_decisions_v2.sql",
);

/** 表现类列的判据：子串。宁可误报不要漏——理由见头注。 */
const PERFORMANCE_COLUMN_PATTERNS = [
  "score",
  "count",
  "perform",
  "reviewed",
  "mastery",
  "evidence_of_practice",
  "attempts",
  "last_practiced",
  "streak",
];

/** 允许出现的那些不是表现类的列（`evidence` 是"确认那一刻的依据"，不是学习证据）。 */
const ALLOWED_COLUMN_FRAGMENTS = [
  "id",
  "workspace_id",
  "user_id",
  "note_id",
  "from_objective_id",
  "to_objective_id",
  "relation",
  "decision",
  "evidence",
  "created_at",
  "updated_at",
];

/** 只取 drizzle 那一段表定义里的列：`xxx: timestamp("xxx_col", {...})` 这一形。 */
function drizzleColumns(source: string): string[] {
  // 注意末尾**不能**要求 `)`：`timestamp("created_at", { withTimezone: true })` 在列名之后
  // 还有参数，第一版写成 `\("([a-z_]+)"\)` 于是把 created_at／updated_at 漏掉了
  // （而迁移那一侧认得出它们，于是"两边不许漂"那条判据恒红——第一版的真死法）。
  return [...source.matchAll(/^\s*\w+:\s*\w+\("([a-z_]+)"/gm)].map((m) => m[1]);
}

/**
 * 只取 `CREATE TABLE public.personal_relation_decisions_v2 (…)` 那一段里的列。
 *
 * 两个坑：
 *  - 不能整份扫：迁移后半截有 plpgsql 的 `DECLARE t text; tables text[] := …`，
 *    正则会把 `t` 与 `tables` 当成列（第一版真死法之二）。
 *  - **找不到就返回空数组，不抛**：下面那格把两个提取器同时喂给两个文件，
 *    所以对 drizzle 那个文件问"CREATE TABLE 在哪"是正常的一问。
 *    真的要在迁移那一侧确认"表还在"的话，`test:migrations` 那几格会管。
 */
function migrationColumns(source: string): string[] {
  const at = source.indexOf("CREATE TABLE public.personal_relation_decisions_v2 (");
  if (at === -1) return [];
  const end = source.indexOf("\n);", at);
  if (end === -1) return [];
  return [...source.slice(at, end).matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|jsonb|timestamptz|integer|boolean)\b/gm)]
    .map((m) => m[1]);
}

function columnNames(source: string): string[] {
  return [...new Set([...drizzleColumns(source), ...migrationColumns(source)])].filter(Boolean);
}

test("drizzle schema 与迁移里的列名一致（两个来源不许漂）", () => {
  const fromSchema = columnNames(readFileSync(SCHEMA_FILE, "utf8"));
  const fromMigration = columnNames(readFileSync(MIGRATION_FILE, "utf8"));
  assert.ok(fromSchema.length >= 8, `drizzle 侧只认出 ${fromSchema.length} 列，判据可能已经瞎了`);
  assert.deepEqual([...fromSchema].sort(), [...fromMigration].sort(),
    "drizzle schema 与迁移 0302 的列名对不上：加了一列只改了一边");
});

test("这张表不许有「表现类」列——确认一条关系不是一次学习表现（§11.3）", () => {
  for (const file of [SCHEMA_FILE, MIGRATION_FILE]) {
    const source = readFileSync(file, "utf8");
    const offenders = columnNames(source)
      .filter((c) => PERFORMANCE_COLUMN_PATTERNS.some((p) => c.includes(p)))
      .filter((c) => !ALLOWED_COLUMN_FRAGMENTS.includes(c));
    assert.deepEqual(offenders, [],
      `${file}: 这些列会把「我确认过这条关系」画成「我在这条关系上练过」（§11.3 不伪造过去的学习事实）`);
  }
});

test("判据自己的灵敏度：加一个 `performance_score` 列必须被抓到", () => {
  // 同一套子串逻辑，对着合成列名各判一次。
  const hit = (c: string) => PERFORMANCE_COLUMN_PATTERNS.some((p) => c.includes(p));
  assert.equal(hit("performance_score"), true, "performance_score 没被抓到，判据是瞎的");
  assert.equal(hit("observed_count"), true, "observed_count 没被抓到");
  assert.equal(hit("last_reviewed_at"), true, "last_reviewed_at 没被抓到");
  // 放行的那几个不能被误伤，否则这条守卫会逼着人起歪名字。
  for (const ok of ALLOWED_COLUMN_FRAGMENTS) {
    assert.equal(hit(ok), false, `${ok} 被误报了`);
  }
});
