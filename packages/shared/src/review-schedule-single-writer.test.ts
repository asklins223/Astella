/**
 * `review_schedules` 的写入只有一个入口（39d W7-2 那条唯一调度边界的前置判据）。
 *
 * 为什么这条要常驻：D2 §3 把"建立/关联那一条待处理安排"收成唯一函数
 * `ensurePendingReviewScheduleV2`，并且与迁移 0287 那把**部分唯一索引同一批**落地。
 * 顺序或纪律反了都会更糟：只要还剩一处裸 `insert` 在写 `status = 'pending'`，
 * 症状就从"同一目标多一条安排"变成"那一次保存整发 23505"。2026-09-27 现读：
 * 运行时只有边界文件自己那一处写入，五个调用方（结算 tick 四条 ＋ 激活那一发）全部走函数。
 * 这条判据守的是**以后**——谁再加第六个写入口，这里先红，而不是等一次线上唯一冲突。
 *
 * 顺带守住配对的那两样，缺任一这条边界就不成立：schema 与迁移里那把索引的名字还在，
 * 以及边界自己仍是"不带 target 的 `onConflictDoNothing()` ＋ 回读，回读不到就抛"。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
/** 只扫**运行时**：测试与集测里造夹具行是允许的（它们正是在验那把索引）。 */
const RUNTIME_ROOTS = [
  "apps/api/src",
  "apps/desktop-client/src",
  "workers/ai-worker/src",
  "packages/shared/src",
];
const BOUNDARY_FILE = "apps/api/src/modules/review/review-schedule-boundary.ts";
const INDEX_NAME = "review_schedules_pending_subject_dim_unique";
const MIGRATION_FILE = "apps/api/src/db/migrations/0287_review_schedule_dimension_unique.sql";

const WRITE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  // drizzle：`.insert(reviewSchedules)` / `.upsert(reviewSchedules)`，允许换行与缩进。
  { label: "drizzle 写入", re: /\b(?:insert|upsert)\(\s*reviewSchedules\b/g },
  // 原生 SQL：夹具与迁移里最常见的写法，大小写都算。
  { label: "原生 INSERT", re: /\b(?:insert|upsert)\s+into\s+review_schedules\b/gi },
];

/** 这份源码里有几处"往 review_schedules 写行"的形状。 */
function writeSites(source: string): string[] {
  const hits: string[] = [];
  for (const { label, re } of WRITE_PATTERNS) {
    // 连 flags 一起复制：只补一个 "g" 会把 `i` 丢掉，于是大小写都写的原生 SQL
    // 只认小写那一种——判据会安静地漏掉一半写法（这条灵敏性用例第一次跑就抓到它）。
    const matches = source.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));
    for (const match of matches ?? []) hits.push(`${label}: ${match.trim()}`);
  }
  return hits;
}

function runtimeSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      // 测试与集测自己造行是正当的（那把索引的行为就靠它们验）。
      if (/\.(test|integration)\.[t]sx?$/.test(entry)) continue;
      out.push({ rel: full.slice(REPO_ROOT.length + 1), text: readFileSync(full, "utf8") });
    }
  };
  for (const root of RUNTIME_ROOTS) walk(join(REPO_ROOT, root));
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

test("分母自证：真的扫到了运行时源码，而且判据读得到边界那一处", () => {
  const files = runtimeSources();
  assert.ok(
    files.length > 150,
    `只扫到 ${files.length} 份运行时源码：walk 或 REPO_ROOT 坏了，这条判据就空转了`,
  );
  const boundary = files.find((f) => f.rel === BOUNDARY_FILE);
  assert.ok(boundary, `扫描里没有 ${BOUNDARY_FILE}，后面的判据无从判起`);
  assert.ok(
    writeSites(boundary.text).length >= 1,
    "边界文件自己都没被读成一处写入 ⇒ 判据读不到真实形状，红绿都不可信",
  );
});

test("判据本身是灵敏的：两种写法都读得到，非写入形状不误报", () => {
  assert.equal(writeSites("await tx.insert(reviewSchedules).values({ status: 'pending' })").length, 1);
  assert.equal(writeSites("await tx\n  .insert(\n  reviewSchedules,\n)").length, 1);
  assert.equal(writeSites("await tx`INSERT INTO review_schedules (id) VALUES (1)`").length, 1);
  assert.equal(writeSites("await tx`insert into review_schedules (id) values (1)`").length, 1);
  // 反向：读、类型引用、以及另一张表的同名前缀都不算写入。
  assert.deepEqual(writeSites("await tx.select().from(reviewSchedules).where(...)"), []);
  assert.deepEqual(writeSites("const reviewSchedulesByDay = group(rows)"), []);
  assert.deepEqual(writeSites("INSERT INTO review_schedules_archive (id) VALUES (1)"), []);
});

test("运行时只有一个写入入口：除边界文件之外任何一处都红", () => {
  const violations = runtimeSources().flatMap(({ rel, text }) =>
    rel === BOUNDARY_FILE ? [] : writeSites(text).map((site) => `${rel} → ${site}`),
  );
  assert.deepEqual(
    violations,
    [],
    `review_schedules 出现了第二个写入口：${violations.join("；")}。`
      + "请改调 ensurePendingReviewScheduleV2——0287 之后裸 insert 不会再多一条安排，"
      + "只会把那一发变成 23505（或撞 UNIQUE 后整发回滚）。",
  );
});

/** 边界成立所依赖的三样东西，抽成**纯判据**：灵敏性就能用内存里的变异来验，不必去改生产文件。 */
function declaresIndex(source: string): boolean {
  return source.includes(INDEX_NAME);
}
function usesBlindDoNothing(source: string): boolean {
  return source.includes(".onConflictDoNothing()");
}
function throwsWhenReadBackMisses(source: string): boolean {
  return /if \(!existing\) \{[\s\S]{0,200}throw new Error/.test(source);
}

test("配对判据自己也要灵敏：改名、换成覆盖写、去掉那一档，三条分别该判不成立", () => {
  const schema = readFileSync(join(REPO_ROOT, "packages/shared/src/db-schema/evidence.ts"), "utf8");
  const boundary = readFileSync(join(REPO_ROOT, BOUNDARY_FILE), "utf8");
  // 正向：三条在当前树上都成立（不成立就是读错了文件，下面的负向也就无从判起）。
  assert.ok(declaresIndex(schema), "schema 那份读不到索引名");
  assert.ok(usesBlindDoNothing(boundary), "边界文件读不到 DO NOTHING 那一支");
  assert.ok(throwsWhenReadBackMisses(boundary), "边界文件读不到「回读不到就抛」那一档");
  // 反向：每一条都在**同一份文本**上做一次内存变异，判据必须跟着翻。
  assert.ok(!declaresIndex(schema.replace(new RegExp(INDEX_NAME, "g"), "renamed_away_idx")),
    "索引改名后仍判成立 ⇒ 这条判据恒真");
  assert.ok(!usesBlindDoNothing(boundary.replace(".onConflictDoNothing()", ".onConflictDoUpdate({})")),
    "换成覆盖写后仍判成立 ⇒ 这条判据恒真");
  assert.ok(!throwsWhenReadBackMisses(boundary.replace("if (!existing) {", "if (never) {")),
    "去掉那一档后仍判成立 ⇒ 这条判据恒真");
});

test("边界依赖的那两样还在：部分唯一索引（schema＋迁移）与「冲突后回读、读不到就抛」", () => {
  const schema = readFileSync(join(REPO_ROOT, "packages/shared/src/db-schema/evidence.ts"), "utf8");
  assert.ok(declaresIndex(schema), `schema 里那把部分唯一索引不见了（${INDEX_NAME}）`);
  assert.ok(existsSync(join(REPO_ROOT, MIGRATION_FILE)), `迁移 ${MIGRATION_FILE} 不在了`);
  assert.ok(
    declaresIndex(readFileSync(join(REPO_ROOT, MIGRATION_FILE), "utf8")),
    "迁移里那把索引的名字读不到了",
  );
  const boundary = readFileSync(join(REPO_ROOT, BOUNDARY_FILE), "utf8");
  assert.ok(usesBlindDoNothing(boundary),
    "边界不再是 DO NOTHING 那一支：要么它改成了覆盖别人的到期时间，要么这条判据该同步改口径");
  assert.ok(throwsWhenReadBackMisses(boundary),
    "边界丢了「冲突后回读不到就抛」那一档：那时它会安静交回一个猜出来的 id");
});
