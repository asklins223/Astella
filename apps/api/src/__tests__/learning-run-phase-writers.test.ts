/**
 * learning_run 的 `phase` 取值台账：**有读的那一档，必须有写方；没人写就得在这里说明为什么**。
 *
 * 动因（39d §19 的 W6-3 那两行）：§16.36 要的「评估已取消」那一档，`cancelled` 在合同里活着、
 * 被两处读（`run-service.ts:1617` 与 `:3121`），**全仓没有一个写入方** ⇒ 那两条读分支恒不成立，
 * 界面也就永远说不出那句「回答已保存，评估已取消」。同一把尺子量下来 `stale` 也是这样一档。
 * 这类东西最坏的地方不是"还没做"，而是**它长得像已经做了**：合同里有、类型里有、代码里也在读。
 *
 * 判据不判对错：这一枚守卫只要求"每一档要么有人写、要么在 LEDGER 里登记"，
 * 并且**两个方向都会红**——新加一档没人写 ⇒ 红；登记过的那档后来接上了写入方 ⇒ 也红（要求删格）。
 *
 * 三条读法上的小心，都写成判据了：
 *  ① `preparing` 没有代码字面量，它由列默认值写（`db-schema/learning-runs.ts` 的
 *     `.default("preparing")`）⇒ 默认值算写方，不然这条守卫会把"其实一直在写"的那档报成缺口；
 *  ② 注释里的 `phase: "cancelled"` **不算写方**（本仓库踩过：注释里的调用也被数进去过），
 *     所以扫之前先剥注释；
 *  ③ `reasonCode: "stale"`（`run-processing-tick.ts:1948`／`:2027`）是**日程影响那一格的原因码**，
 *     与 run 的 phase 不共用词表，不许拿它当 `stale` 的写入方。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { learningRunPhaseV2Schema } from "@ailearn/shared/learning-run-v2-contracts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** 运行时源码目录：写入方与读取方都只在这里找（测试与集测不算数）。 */
const RUNTIME_DIRS = ["apps/api/src", "workers/ai-worker/src", "apps/desktop-client/src"] as const;
/** 列默认值的住处：`phase` 那一列的 `.default(...)` 也算写入方。 */
const SCHEMA_FILE = "packages/shared/src/db-schema/learning-runs.ts";

/**
 * 今天确实没有写入方的那两档，逐条说明归哪一刀。
 * 每一格都带着**读它的坐标**——只登记"没人写"而不说"谁在读"，就成了第二条没人读的清单。
 */
const LEDGER: Record<string, string> = {
  cancelled: "§16.36「取消晚于成功提交…当次显示『回答已保存，评估已取消』」那一刀的欠账（读在 run-service.ts:1617／:3121，写在等 W5-1 那条独立命令）",
  stale: "§5.5 之外没人定义过谁把 run 标成 stale；读同样在 run-service.ts:1617／:3121。要么给出写入方，要么把这档从合同里摘掉",
};

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function runtimeSources(): Array<{ rel: string; text: string }> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      // 测试与集测里的赋值不是运行时写入方。
      if (/(\.test|\.integration)\.(ts|tsx)$/.test(entry)) continue;
      files.push(full);
    }
  };
  for (const rel of RUNTIME_DIRS) walk(resolve(REPO_ROOT, rel));
  return files.map((full) => ({
    rel: full.slice(REPO_ROOT.length + 1),
    text: readFileSync(full, "utf8"),
  }));
}

type PhaseVerdict = {
  phase: string;
  writers: string[];
  viaSchemaDefault: boolean;
  readers: string[];
};

/** 剥注释这件事归判定方，不归调用方——不然"注释不算写方"这条会随着调用点忘记剥而失效。 */
function judge(phases: readonly string[], sources: Array<{ rel: string; text: string }>, rawSchemaText: string): PhaseVerdict[] {
  const schemaText = stripComments(rawSchemaText);
  return phases.map((phase) => {
    const writers: string[] = [];
    const readers: string[] = [];
    for (const { rel, text: raw } of sources) {
      const text = stripComments(raw);
      if (new RegExp(`phase:\\s*["']${phase}["']`).test(text)) writers.push(rel);
      if (new RegExp(`phase\\s*===\\s*["']${phase}["']`).test(text)
        || new RegExp(`case\\s+["']${phase}["']`).test(text)) readers.push(rel);
    }
    return {
      phase,
      writers,
      viaSchemaDefault: new RegExp(`default\\(\\s*["']${phase}["']\\s*\\)`).test(schemaText),
      readers,
    };
  });
}

const phases = [...learningRunPhaseV2Schema.options];
const sources = runtimeSources();
const schemaText = readFileSync(resolve(REPO_ROOT, SCHEMA_FILE), "utf8");
const verdicts = judge(phases, sources, schemaText);

test("分母自证：清单来自合同的 enum 本身，且两条已知形状各判各的", () => {
  assert.ok(phases.length >= 10, `phase 这一族至少该有十档，实际 ${phases.length}——分母读空了`);
  assert.equal(phases.length, new Set(phases).size, "分母里有重复取值（enum 与手抄名单的失效形状）");
  const byPhase = new Map(verdicts.map((item) => [item.phase, item]));
  // 有代码字面量写入方的那一档，必须被读到（否则下面所有"零写方"的判断都是瞎的）。
  const active = byPhase.get("active");
  assert.ok(active && active.writers.length > 0, "`active` 被判成没有写方 ⇒ 扫描根本没读到位");
  // 只有列默认值的那一档也算有写方，不然会把"一直在写"报成缺口。
  const preparing = byPhase.get("preparing");
  assert.ok(preparing && preparing.writers.length === 0 && preparing.viaSchemaDefault,
    "`preparing` 应由列默认值写入；这条不成立说明默认值那条读法失效了");
});

test("每一档要么有写入方、要么在台账里登记；两样都没有就红", () => {
  const unregistered = verdicts.filter(
    (item) => item.writers.length === 0 && !item.viaSchemaDefault && !(item.phase in LEDGER),
  );
  assert.deepEqual(unregistered.map((item) => ({
    phase: item.phase,
    readBy: item.readers,
  })), [], "合同里新增了一档却没人写、也没登记：给它写入方，或在这里说明归哪一刀");
});

test("台账登记的每一档今天确实无人写、且真的有人在读；接上了就必须删格", () => {
  const problems: string[] = [];
  for (const [phase, note] of Object.entries(LEDGER)) {
    const verdict = verdicts.find((item) => item.phase === phase);
    if (!verdict) { problems.push(`${phase}：台账里还挂着，合同里已经没有这一档`); continue; }
    if (verdict.writers.length > 0 || verdict.viaSchemaDefault) {
      problems.push(`${phase}：已经有写入方了（${[...new Set(verdict.writers)].join("、") || "列默认值"}），把台账里那一格删掉`);
    }
    if (verdict.readers.length === 0) problems.push(`${phase}：没人写也没人读——这一档该从合同里摘掉，而不是登记`);
    assert.ok(note.includes(".ts:"), `${phase}：登记语里要带读它的坐标（file:line）`);
  }
  assert.deepEqual(problems, [], "台账与现状不一致");
});

test("判据自己的灵敏度：假数据喂出四种形状各判各的", () => {
  const fake = [
    { rel: "apps/api/src/fake-a.ts", text: 'tx.update(learningRuns).set({ phase: "ended" })' },
    { rel: "apps/api/src/fake-b.ts", text: 'if (run.phase === "watched") { /* 读 */ }' },
    // 注释里出现的那一条**不许**算写入方。
    { rel: "apps/api/src/fake-c.ts", text: '// 将来会写 phase: "documented"\nconst x = 1;' },
    { rel: "packages/shared/src/db-schema/fake.ts", text: 'phase: text("phase").default("seeded")' },
  ];
  const out = judge(["ended", "watched", "documented", "seeded", "nobody"], fake, 'phase: text("phase").default("seeded")');
  const byPhase = new Map(out.map((item) => [item.phase, item]));
  assert.deepEqual(byPhase.get("ended")?.writers, ["apps/api/src/fake-a.ts"]);
  assert.deepEqual(byPhase.get("watched")?.readers, ["apps/api/src/fake-b.ts"]);
  assert.equal(byPhase.get("documented")?.writers.length, 0, "注释里的字面量被当成写入方了");
  assert.equal(byPhase.get("seeded")?.viaSchemaDefault, true, "列默认值没被认成写入方");
  assert.equal(byPhase.get("nobody")?.writers.length, 0);
  assert.equal(byPhase.get("nobody")?.readers.length, 0);
});
