/**
 * 0413 的形状：`sessions.client_kind`（TS 那一份与库里那一份必须同宽）。
 *
 * 与 `0353` / `0385` 同一手法——这类"列在代码里声明了、库里却没有"的分裂是这个仓库
 * 有记录的事故形状（journal 没登记 → runner 静略过 → `select()` 全列时炸）。
 * 行为本身（手机会话吃 403）不在这里测，见
 * `integration-tests/mobile-note-write-scope-postgres.integration.ts`。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0413_sessions_client_kind.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string; breakpoints?: boolean }> };
const dbSchema = readFileSync(
  new URL("../../../../packages/shared/src/db-schema/session.ts", import.meta.url),
  "utf8",
);

test("0413 登记进 journal：migrate.ts 以 journal 为唯一清单来源", () => {
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0413_sessions_client_kind"),
    "未登记的迁移永远不会被应用（0221/0222 就是这么漏的）",
  );
  const entry = journal.entries.find((item) => item.tag === "0413_sessions_client_kind");
  assert.equal(entry?.breakpoints, true, "多条语句要用 statement-breakpoint 切分");
});

test("0413 加的是带缺省的非空列，桌面端因此一次调用都不用改", () => {
  assert.match(migration, /ALTER TABLE public\.sessions/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS client_kind text NOT NULL DEFAULT 'desktop'/);
  // 只加列：sessions 上已有的 RLS 策略与索引不动（策略计数是硬断言，见 0406 的说明）。
  assert.doesNotMatch(migration, /DROP COLUMN|DROP POLICY|ENABLE ROW LEVEL SECURITY/);
});

test("0413 把取值域落成库里的 CHECK，不只是 TS 里的约定", () => {
  assert.match(migration, /ADD CONSTRAINT sessions_client_kind_check CHECK \(client_kind IN \('desktop', 'mobile'\)\)/);
  // 重跑同一句不该炸（幂等约定：先 DROP CONSTRAINT IF EXISTS）。
  assert.match(migration, /DROP CONSTRAINT IF EXISTS sessions_client_kind_check/);
});

test("drizzle 那一份声明与迁移同宽", () => {
  assert.match(dbSchema, /clientKind: text\("client_kind"\)\.default\("desktop"\)\.notNull\(\)/);
  assert.match(dbSchema, /check\("sessions_client_kind_check"/);
});
