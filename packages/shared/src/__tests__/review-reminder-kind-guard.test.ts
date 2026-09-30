/**
 * `reminder_kind` 的三份声明必须逐字一致：schema 的 `$type` 联合、迁移 0297 的 CHECK、
 * 线上合同的枚举。
 *
 * 为什么要一条判据看着像"抄第三遍"：这三份**本来就得各写一遍**（一个 TypeScript 联合、
 * 一条 SQL CHECK、一个 zod 枚举，没有办法让其中一份从另一份推导出来）。既然免不了，
 * 那就让它抄错时**响**——这份表在 schema 与迁移之间已经有过一次同源的漂移教训
 * （`review-schedule-single-writer.test.ts` 里那两段"schema 与迁移里那把索引的名字还在"
 * 就是同一个形状的先例）。少这一条，"改了 schema 忘了改迁移"会安静地过很久：运行时会
 * 在**写进第三种取值**的那一刻才炸，而那一刻通常是一次真实的学习。
 *
 * 三条判据各自在两个方向自证：改动任一份，判据都要跟着翻。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ReviewReminderKindValues } from "../db-schema/evidence.ts";
import { reviewReminderKindV2Schema } from "../contracts/review-reminder-contracts.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCHEMA_FILE = join(REPO_ROOT, "packages/shared/src/db-schema/evidence.ts");
const MIGRATION_FILE = join(REPO_ROOT, "apps/api/src/db/migrations/0297_review_schedule_reminder_kind.sql");

/** 从 CHECK 那一行里读出 IN 列表，逐项去空白去引号。 */
function kindsInMigrationCheck(source: string): string[] {
  const clause = source.match(/reminder_kind\s+IN\s*\(([^)]*)\)/i);
  assert.ok(clause, "迁移里读不到 `reminder_kind IN (...)` 那一档：判据空转");
  return clause[1].split(",").map((part) => part.trim().replace(/^'|'$/g, "")).filter(Boolean);
}

test("三份声明一致：schema 联合、迁移 CHECK、线上枚举", () => {
  const migrationKinds = kindsInMigrationCheck(readFileSync(MIGRATION_FILE, "utf8"));
  assert.deepEqual(
    [...ReviewReminderKindValues].sort(),
    migrationKinds.sort(),
    "schema 的 reminderKind 联合与迁移 0297 的 CHECK 不是同一组取值——运行时会接受一种、类型层却当它不存在",
  );
  assert.deepEqual(
    [...reviewReminderKindV2Schema.options].sort(),
    [...ReviewReminderKindValues].sort(),
    "线上合同枚举与 schema 不一致：界面能发出一种、数据库会拒掉",
  );
});

test("判据对 schema 侧灵敏：改一份就红（不是恒真）", () => {
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  // 阳性：当前树上两份都读得到（读不到就是读错了文件，下面的负向无从判起）。
  assert.ok(schema.includes('text("reminder_kind")'), "schema 里读不到 reminder_kind 那一列");
  // 负向：把 schema 的联合改窄一位，迁移那份不动，判据必须跟着翻。
  const drifted = ReviewReminderKindValues.filter((k) => k !== "one_time");
  assert.notDeepEqual([...drifted].sort(), kindsInMigrationCheck(readFileSync(MIGRATION_FILE, "utf8")).sort());
});

test("判据对迁移侧灵敏：把 CHECK 改宽/改窄都要红", () => {
  const source = readFileSync(MIGRATION_FILE, "utf8");
  const original = kindsInMigrationCheck(source);
  const narrowed = source.replace(
    /reminder_kind\s+IN\s*\([^)]*\)/i,
    "reminder_kind IN ('sustained')",
  );
  assert.notDeepEqual(kindsInMigrationCheck(narrowed), original, "把 CHECK 改窄后仍判一致 ⇒ 这条判据读不到那一档");
  const widened = source.replace(
    /reminder_kind\s+IN\s*\([^)]*\)/i,
    "reminder_kind IN ('one_time', 'sustained', 'whatever')",
  );
  assert.notDeepEqual(kindsInMigrationCheck(widened), original, "把 CHECK 改宽后仍判一致 ⇒ 这条判据读不到那一档");
});

test("存量的默认档是持续，不是单次（0297 头注第 3 条的判据）", () => {
  const migration = readFileSync(MIGRATION_FILE, "utf8");
  // 迁移里那一列必须 NOT NULL 且默认 sustained；反过来（默认 one_time）会让今天所有
  // 排程在处理后静默不再排下一次，而没有任何人授权过这件事。
  assert.match(
    migration,
    /reminder_kind\s+text\s+NOT\s+NULL\s+DEFAULT\s+'sustained'/i,
    "迁移没有把 reminder_kind 设成 NOT NULL DEFAULT 'sustained'：存量行的档位就没有被钉住",
  );
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  assert.match(
    schema,
    /reminderKind:[\s\S]{0,220}?\.notNull\(\)\.default\("sustained"\)/,
    "schema 的 reminderKind 没有 notNull + 默认 sustained：它与迁移脱钩了",
  );
});
