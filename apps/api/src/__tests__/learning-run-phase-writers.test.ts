/**
 * learning_run 的 `phase` 取值台账：**两个方向都要有人**——有读的那一档必须有写方，
 * 有写的那一档必须有人读；没人写就得在这里说明为什么，没人读也一样（反向那一腿见 `LEDGER_UNHEARD`）。
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
 *
 * **09-27 自查后加的第④条**（这一版原来错在写法上，结论侥幸没错）：本仓库有**两张表都用
 * `phase` 这一列名**——轮次状态机也写 `phase: "active"`/`"paused"`（`round-service.ts:670`
 * 那份 `next.state.phase`）。原来的"看到 `phase: "X"` 就算 run 的写入方"会把别的表的写入
 * 算进来：实测 `active` 宽口径 5 个、窄口径只有 1 个。今天两档没人写的结论在两种口径下
 * 都是 0，所以登记没错；但**方法**必须收窄，否则下一个真缺口能被别的表的一行掩盖掉。
 * 同一天在另一枚守卫上刚犯过一次相邻的错（拿字面量断言"零生产者"，结果那一档是
 * **变量形状**落库的），所以这里一并把变量形状管起来：落在 learningRuns 写入窗口里的
 * `phase: <标识符>` 一律算"判不了"，必须显式登记，不许静默当"没人写"。
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

/**
 * 落在 learningRuns 写入窗口里、但写入值是变量（字面量判不了落哪一档）的位置。
 * 今天为空。有了就必须要么改掉字面量分支、要么在这里登记一行并写明它可能产出哪些档——
 * **没有人工过账之前，这一枚守卫不许宣称任何一档"零写入方"**。
 */
const UNJUDGED_RUN_WRITES = new Set<string>([
]);

/**
 * 今天确实**没有读者**的那几档（09-27 实测：零档，这一张表是空的）。
 * 有档进这张表就必须写清"谁以后会读它"，否则它就是 §19 里"合同里有、代码里也在读"那种形状的镜像——
 * 只是这次是"状态机在落、没人认"。反向那一腿见同名用例。
 */
const LEDGER_UNHEARD: Record<string, string> = {
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

/** 一处 learningRuns 的写入语句：`.update(learningRuns)`／`.insert(learningRuns)`。 */
const RUN_WRITE_WINDOW = 220;

function runWritePositions(text: string): number[] {
  const positions: number[] = [];
  for (const match of text.matchAll(/(?:update|insert)\(learningRuns\)/g)) {
    if (match.index !== undefined) positions.push(match.index);
  }
  return positions;
}

/** `phase:` 那一格离最近一处 run 写入语句有多近（没有就返回 -1）。 */
function distanceToRunWrite(positions: number[], at: number): number {
  let best = -1;
  for (const position of positions) {
    const delta = at - position;
    if (delta >= 0 && delta <= RUN_WRITE_WINDOW && (best === -1 || delta < best)) best = delta;
  }
  return best;
}

/**
 * 判定一档的写入方。**只认落在 learningRuns 写入窗口里的字面量**——
 * 轮次状态机那张表也有一列叫 `phase`，宽口径会把它的写入算过来。
 */
function judge(phases: readonly string[], sources: Array<{ rel: string; text: string }>, rawSchemaText: string): {
  verdicts: PhaseVerdict[];
  unjudged: string[];
} {
  const schemaText = stripComments(rawSchemaText);
  const scoped = sources.map(({ rel, text: raw }) => {
    const text = stripComments(raw);
    return { rel, text, runWrites: runWritePositions(text) };
  });
  const unjudged: string[] = [];
  const verdicts = phases.map((phase) => {
    const writers: string[] = [];
    const readers: string[] = [];
    for (const { rel, text, runWrites } of scoped) {
      for (const match of text.matchAll(new RegExp(`phase:\\s*["']${phase}["']`, "g"))) {
        if (distanceToRunWrite(runWrites, match.index ?? 0) >= 0) writers.push(rel);
      }
      // 变量形状的写入判不了归谁：落在 run 写入窗口里的必须显式登记，不许当成"没人写"。
      for (const match of text.matchAll(/phase:\s*([A-Za-z_$][\w$.]*)(?!\s*[:=])/g)) {
        if (distanceToRunWrite(runWrites, match.index ?? 0) >= 0) unjudged.push(`${rel} → phase: ${match[1]}`);
      }
      if (new RegExp(`phase\\s*===\\s*["']${phase}["']`).test(text)
        || new RegExp(`case\\s+["']${phase}["']`).test(text)) readers.push(rel);
    }
    return {
      phase,
      writers: [...new Set(writers)],
      viaSchemaDefault: new RegExp(`default\\(\\s*["']${phase}["']\\s*\\)`).test(schemaText),
      readers: [...new Set(readers)],
    };
  });
  return { verdicts, unjudged: [...new Set(unjudged)] };
}

const phases = [...learningRunPhaseV2Schema.options];
const sources = runtimeSources();
const schemaText = readFileSync(resolve(REPO_ROOT, SCHEMA_FILE), "utf8");
const { verdicts, unjudged } = judge(phases, sources, schemaText);

test("写入方按**表**收窄：别的表那一列也叫 phase，不算 run 的写入方", () => {
  // 轮次状态机确实写着 `phase: "active"`／`"paused"`（round-service.ts:670 那份 reducer 输出），
  // 这条把"口径收窄"这件事钉住：如果哪天有人把窗口规则改宽，这里会先红。
  const roundReducer = sources.find((item) => item.rel.endsWith("note-learning-rounds/round/round-reducer.ts"));
  assert.ok(roundReducer, "轮次状态机那份文件不在了，这条自证就无从做起");
  const activeVerdict = verdicts.find((item) => item.phase === "active");
  assert.ok(activeVerdict && activeVerdict.writers.length > 0, "run 的 active 该有自己的写入方（run-service）");
  assert.equal(activeVerdict.writers.some((rel) => rel.includes("note-learning-rounds")), false,
    "轮次表的写入被算成了 run 的 phase 写入方");
});

test("变量形状的 run 写入判不了归谁，必须显式登记（今天登记的是零处）", () => {
  assert.deepEqual(unjudged.filter((item) => !UNJUDGED_RUN_WRITES.has(item)), [],
    "出现了 `phase: <变量>` 的 run 写入：字面量判不了它落哪一档，这一枚守卫就不能宣称『这一档没人写』——"
    + "人工看过之后把它登记进 UNJUDGED_RUN_WRITES，或者改成字面量分支");
  for (const entry of UNJUDGED_RUN_WRITES) {
    assert.ok(unjudged.includes(entry), `登记过的 ${entry} 已经不在了，把这条登记删掉`);
  }
});

/**
 * 反方向那一腿：**有人写的每一档必须有人读**。
 *
 * 为什么两个方向都要钉（2026-09-27 实测过才补的）：今天 12 档里读者最少的是 `skipped`（1 处），
 * 没有任何一档"写了没人读"——这一腿现在抓不到现存缺陷，它抓的是**下一刀**：往 enum 里加一档、
 * 状态机开始往那儿落，而投影与桌面各按自己的 `switch`/`===` 认档，那一档进来就是一张没有分支的屏。
 * 上一格那种"长得像已经做了"是恒不成立的分支，这一种是**恒不显示的分支**，同一类事故的两个方向。
 *
 * 判"没人读"用的是运行时源码里的两种认法（`phase === "X"` 与 `case "X"`），
 * 与正向那腿同一套剥注释与目录口径；`readers` 已经在 verdict 里，不另起一套扫描。
 */
test("每一档要么有人读、要么在这里说明为什么没有人读（反向那一腿）", () => {
  const unheard = verdicts.filter((item) => item.readers.length === 0);
  assert.deepEqual(unheard.map((item) => item.phase).filter((phase) => !(phase in LEDGER_UNHEARD)), [],
    "有一档状态机在往那儿落、却没有任何一处读它：要么补上认这一档的分支，要么登记它归哪一刀");
  for (const phase of Object.keys(LEDGER_UNHEARD)) {
    assert.ok(unheard.some((item) => item.phase === phase),
      `${phase} 已经有读者了，把 LEDGER_UNHEARD 里那一格删掉`);
  }
  // 地板：这一腿不许在"全部读不到"的情况下静默成立（分母读空时 unheard 会一大片）。
  const readCounts = verdicts.map((item) => item.readers.length);
  assert.ok(Math.min(...readCounts) >= 0 && readCounts.filter((n) => n > 0).length >= phases.length - 1,
    `只有 ${readCounts.filter((n) => n > 0).length}/${phases.length} 档读得到读者 ⇒ 认档的口径本身失效了，不是缺分支`);
});

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

test("判据自己的灵敏度：假数据喂出五种形状各判各的", () => {
  const fake = [
    { rel: "apps/api/src/fake-a.ts", text: 'tx.update(learningRuns).set({ phase: "ended" })' },
    { rel: "apps/api/src/fake-b.ts", text: 'if (run.phase === "watched") { /* 读 */ }' },
    // 注释里出现的那一条**不许**算写入方。
    { rel: "apps/api/src/fake-c.ts", text: '// 将来会写 phase: "documented"\nconst x = 1;' },
    // 别的表也叫 phase：窗口里没有 learningRuns 的写入语句，不算 run 的写入方。
    { rel: "apps/api/src/fake-d.ts", text: 'tx.update(noteLearningRounds).set({ phase: "adjacent" })' },
    // 变量形状的 run 写入：判不了归谁，得进 unjudged 清单。
    { rel: "apps/api/src/fake-e.ts", text: 'tx.update(learningRuns).set({ phase: next.state.phase })' },
    { rel: "packages/shared/src/db-schema/fake.ts", text: 'phase: text("phase").default("seeded")' },
  ];
  const { verdicts: out, unjudged: un } = judge(
    ["ended", "watched", "documented", "adjacent", "seeded", "nobody"], fake, 'phase: text("phase").default("seeded")',
  );
  const byPhase = new Map(out.map((item) => [item.phase, item]));
  assert.deepEqual(byPhase.get("ended")?.writers, ["apps/api/src/fake-a.ts"]);
  assert.deepEqual(byPhase.get("watched")?.readers, ["apps/api/src/fake-b.ts"]);
  assert.equal(byPhase.get("documented")?.writers.length, 0, "注释里的字面量被当成写入方了");
  assert.equal(byPhase.get("adjacent")?.writers.length, 0, "别的表的 phase 写入被算成了 run 的");
  assert.deepEqual(un, ["apps/api/src/fake-e.ts → phase: next.state.phase"], "变量形状的 run 写入没被挑出来");
  assert.equal(byPhase.get("seeded")?.viaSchemaDefault, true, "列默认值没被认成写入方");
  assert.equal(byPhase.get("nobody")?.writers.length, 0);
  assert.equal(byPhase.get("nobody")?.readers.length, 0);
});
