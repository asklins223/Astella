/**
 * 制卡链入口台账（39d W7-1／W7-7 刀一）。
 *
 * 这条守卫盯的是**入口与总控的关系**，两件事各一格：
 *
 * 1. 改前的事实：总控 `CARD_GENERATION_CHAIN` 只管到第一次生成那一发，而它当时是
 *    `generation-run-service` 的模块私有函数——审核台上的四发与"再生成一次"绕开它直接
 *    投旧链的 jobType。后果不是"多跑一次旧链"这么简单：一条新链 run 会被旧四阶段链重新
 *    规划，同一篇笔记上两批候选来自两条链，而"切换完成"看上去只取决于那个开关。
 *    今天判**每一发都得问过总控**（`honoring` 数 = 入口数），漏一处就红。
 * 2. 默认档那一半必须落在新链上：判据取的是三元里**真分支**那个 jobType，不是"文件里
 *    出现过新链的名字"——那样读，off 档写在新链上也会绿。
 *
 * 清单只许变短（与 `integration-run-registration.test.ts` 同法）：某一处消失了却没把
 * 台账改短 ⇒ 红，因为台账留在原地就是它在说谎。W7-7 刀二删掉旧链时，这一格会跟着从
 * "六个入口、每处两档"变成"六个入口、每处一档"。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const API_ROOT = "apps/api/src";
const V3_TASKS_FILE = "workers/ai-worker/src/card-generation-v3/tasks.ts";
const GATE_FN = "cardGenerationSimplifiedChainV3";

/** 简化链的两种 job（整批／逐候选）。真分支只能落在这两个里面。 */
const SIMPLIFIED_JOB_TYPES = ["card_generation_simplified_v1", "card_candidate_refine_v3"];

/**
 * 每一个投进制卡 outbox 的入口，逐条写明是哪一发。
 * 值 = 该文件里那些入队点的 jobType，按源码出现顺序；问过总控的那一处是**两档**
 * （`? 新链 : 旧链`），所以每处两个字面量。
 */
const ENTRY_JOB_TYPES: Record<string, string[]> = {
  "apps/api/src/modules/card-generation-v2/candidate-review-service.ts": [
    // 编辑后重检、合并后重检、按反馈重生成（逐候选那一发），与整批重规划。
    "card_candidate_refine_v3", "card_generation_recheck_candidate",
    "card_candidate_refine_v3", "card_generation_recheck_candidate",
    "card_candidate_refine_v3", "card_generation_regenerate_candidate",
    "card_generation_simplified_v1", "card_generation_replan_set",
  ],
  "apps/api/src/modules/card-generation-v2/generation-run-service.ts": [
    // 第一次生成，与质量门全失败后的"再生成一次"（同一 jobType，payload 里带 mode 区分来意）。
    "card_generation_simplified_v1", "card_generation_plan",
    "card_generation_simplified_v1", "card_generation_replan_set",
  ],
};

/** 与链无关的那一发（不做语义调用，只投投影消费），登记它是为了说明「看过、不算漏」。 */
const CHAIN_AGNOSTIC_ENTRIES: Record<string, string[]> = {
  "apps/api/src/modules/card-generation-v2/activation-service.ts": ["card_v2_post_activation"],
};

/** 简化链已定义的任务（`tasks.ts` 里那几个 `id`）。 */
const V3_TASK_IDS = ["card_generate_v3", "card_content_check_v3", "card_candidate_rewrite_v3"];
/**
 * 三个任务今天都**没有**独立的 outbox 入队点，也都不该有：生成与检查由整批那一发串起来
 * 跑，改写由"检查判 rewrite"与"用户点重生成"两条路各自逐张调用（W7-7 刀一）。
 */
const V3_TASKS_CHAINED_INSIDE_A_JOB = new Set(V3_TASK_IDS);

type Site = { file: string; literals: string[]; honoring: boolean };

/**
 * 采集一个文件里所有制卡 outbox 入队点。
 *
 * 判据锚的是 `.insert(cardGenerationRunOutboxV2)` 那一发语句里的 `jobType:`，不是随便一个
 * 同名字段（别的表也可能有）。**一条 jobType 表达式里可以有两个字面量**——三元那一发写的
 * 就是"问总控 ? 新链 : 旧链"，只取第一个字符串会把旧链那一档漏成不可见。
 * 认「问过总控」要同时看三元写在行内与先算好变量再写 `jobType: jt` 两种形状——只看行内，
 * 有人重写成变量式时就静默漏判。
 */
function enqueueSitesIn(file: string, source: string): Site[] {
  const sites: Site[] = [];
  const insertRe = /\.insert\(\s*cardGenerationRunOutboxV2\s*\)/g;
  for (const insert of [...source.matchAll(insertRe)]) {
    const at = insert.index ?? 0;
    const statement = source.slice(at, at + 1200);
    const jobLine = statement.match(/\bjobType:([^\n]*)/);
    if (!jobLine) continue;
    const quoted = [...jobLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const literals = quoted.length > 0
      ? quoted
      : [`变量:${(jobLine[1].match(/([A-Za-z_$][\w$]*)/) ?? ["", "?"])[1]}`];
    const before = source.slice(Math.max(0, at - 500), at);
    const gate = new RegExp(`${GATE_FN}\\s*\\(`);
    sites.push({ file, literals, honoring: gate.test(jobLine[1]) || gate.test(before) });
  }
  return sites;
}

function runtimeApiSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (relDir: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, relDir))) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const rel = `${relDir}/${entry}`;
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) walk(rel);
      else if (entry.endsWith(".ts") && !/\.(test|integration)\.ts$/.test(entry)) {
        out.push({ rel, text: readFileSync(join(REPO_ROOT, rel), "utf8") });
      }
    }
  };
  walk(API_ROOT);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function allSites(): Site[] {
  return runtimeApiSources().flatMap((f) => enqueueSitesIn(f.rel, f.text));
}

function groupByFile(sites: Site[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of sites) for (const literal of s.literals) (out[s.file] ??= []).push(literal);
  return out;
}

test("分母自证：真读到了那六个入口，也认得出「问过总控」那两种写法", () => {
  const sites = allSites();
  assert.equal(sites.length, 7,
    `读到 ${sites.length} 个制卡 outbox 入队点（六个链入口＋一发与链无关的投影）：walk 或判据坏了`);
  const honoring = sites.filter((s) => s.honoring);
  assert.equal(honoring.length, Object.keys(ENTRY_JOB_TYPES).reduce((n, f) => n + ENTRY_JOB_TYPES[f].length / 2, 0),
    `问过总控的入口数与台账对不上（读到 ${honoring.length} 处）：漏一处就是那儿绕开了总控`);
  const notHonoring = sites.filter((s) => !s.honoring).map((s) => `${s.file}→${s.literals.join("/")}`);
  assert.deepEqual(notHonoring, [
    "apps/api/src/modules/card-generation-v2/activation-service.ts→card_v2_post_activation",
  ], "有入口没问总控，且没登记成「与链无关」");
});

test("默认档落在简化链上：每一处三元的新链那一档排在前面，旧链只在 off 档", () => {
  for (const site of allSites().filter((s) => s.honoring)) {
    assert.ok(SIMPLIFIED_JOB_TYPES.includes(site.literals[0]),
      `${site.file} 那一发的默认档不是简化链的 jobType（读到 ${String(site.literals[0])}）：`
      + "W7-7 刀一翻的就是这一格");
    assert.equal(site.literals.length, 2,
      `${site.file} 那一处应当同时给出新旧两档——off 档要能完全回到改前行为`);
  }
});

test("入口台账：多一处没登记、或某一处消失了却没把清单改短，都红", () => {
  const grouped = groupByFile(allSites());
  const expected = { ...ENTRY_JOB_TYPES, ...CHAIN_AGNOSTIC_ENTRIES };
  for (const [file, literals] of Object.entries(expected)) {
    assert.deepEqual(grouped[file] ?? [], literals,
      `${file} 的入队台账与代码不一致（台账记的是 ${JSON.stringify(literals)}）。`
        + "少一处就删掉对应那两条（清单只许变短）；新加了入口先登记是哪一发。");
  }
  const stray = Object.entries(grouped)
    .filter(([file]) => !(file in expected))
    .map(([file, list]) => `${file} → ${list.join("，")}`);
  assert.deepEqual(stray, [], `出现没登记的制卡 outbox 入口：${stray.join("；")}`);
});

test("V3 任务与 jobType 的入口台账：两种 job 都有人投，三个任务都不该有独立入队点", () => {
  const literals = new Set(allSites().flatMap((s) => s.literals));
  for (const jobType of SIMPLIFIED_JOB_TYPES) {
    assert.ok(literals.has(jobType),
      `简化链的 jobType ${jobType} 没有任何入队点了——那一发被撤了就把这条台账一起删`);
  }
  const tasks = readFileSync(join(REPO_ROOT, V3_TASKS_FILE), "utf8");
  const defined = [...tasks.matchAll(/\bid:\s*"([a-z0-9_]+_v3)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, [...V3_TASK_IDS].sort(),
    `tasks.ts 里的任务定义与台账对不上（实际 ${defined.join("，") || "空"}）：新加任务要在这里登记它谁投`);
  for (const id of defined) {
    assert.ok(V3_TASKS_CHAINED_INSIDE_A_JOB.has(id) && !literals.has(id),
      `${id} 是 job 内部逐张调用的一环，不该有独立入队点；真要给它开一格，先把设计件改过来`);
  }
  // 两种 job 各自要有 worker 侧的处理函数，否则入口投出去没人领（unknown jobType 会把
  // run 打成 needs_attention，那是一发要花两次钱才能发现的错）。
  const dispatcher = readFileSync(
    join(REPO_ROOT, "workers/ai-worker/src/handlers/card-generation-v2-handler.ts"), "utf8");
  for (const jobType of SIMPLIFIED_JOB_TYPES) {
    assert.match(dispatcher, new RegExp(`case "${jobType}"`), `${jobType} 投出去没有分发点接`);
  }
  const handler = readFileSync(join(REPO_ROOT, "workers/ai-worker/src/card-generation-v3/handler.ts"), "utf8");
  assert.match(handler, /export async function processCardGenerationSimplifiedJob/, "整批那一发的处理函数不见了");
  assert.match(handler, /export async function processCardCandidateRefineV3Job/, "逐候选那一发的处理函数不见了");
});

test("判据本身灵敏：三元、变量式、没问过总控，三种写法各判各的", () => {
  const ternary = `await tx.insert(cardGenerationRunOutboxV2).values({\n  jobType: ${GATE_FN}() ? "card_candidate_refine_v3" : "card_generation_recheck_candidate",\n  status: "pending",\n})`;
  const viaVar = `const jt = ${GATE_FN}() ? "a" : "card_generation_replan_set";\nawait tx.insert(cardGenerationRunOutboxV2).values({\n  runId,\n  jobType: jt,\n  status: "pending",\n})`;
  const plain = `await tx.insert(cardGenerationRunOutboxV2).values({\n  jobType: "card_generation_recheck_candidate",\n  status: "pending",\n})`;
  const otherTable = `await tx.insert(someOtherOutbox).values({\n  jobType: "unrelated",\n  status: "pending",\n})`;
  assert.equal(enqueueSitesIn("f.ts", ternary).filter((s) => s.honoring).length, 1,
    "三元写在行内却没被认出来");
  assert.deepEqual(enqueueSitesIn("f.ts", ternary)[0]?.literals,
    ["card_candidate_refine_v3", "card_generation_recheck_candidate"],
    "两档没按「新在前」收进来 ⇒ 上面那条默认档判据会读错");
  assert.equal(enqueueSitesIn("f.ts", viaVar).filter((s) => s.honoring).length, 1,
    "先算好变量再写 `jobType: jt` 没被认出来 ⇒ 真实代码改成变量式就会漏判");
  assert.deepEqual(enqueueSitesIn("f.ts", plain).filter((s) => s.honoring), [],
    "什么都没问却被判成问过总控 ⇒ 判据恒真");
  assert.deepEqual(enqueueSitesIn("f.ts", otherTable), [],
    "别的表的 jobType 也被收进来了 ⇒ 台账会被不相干的功能误伤");
});

/**
 * 逐用例档位（`delete process.env.CARD_GENERATION_CHAIN`）的守卫（39d W7-7 刀二期间加的）。
 *
 * 为什么需要：搬到默认档的判据现在靠"文件头钉 `v2` ＋ 该条用例开头摘档位"这套写法。
 * 它有两种静默失效：① 摘了档位却没有每发复位 ⇒ 档位漏给后面的用例，那些用例**看起来绿**、
 * 实际跑的链与台账不符；② 有人把某条 `delete` 删了（或探针那一格被当冗余清理）⇒ 台账里
 * "已搬到默认档"的条数缩水，而没有任何东西会变红。所以这里既查复位，也把条数当**只涨不跌**
 * 的棘轮钉住（继续搬用例就把它涨上去，往回偷偷搬就红）。
 */
const PER_CASE_SWITCH_FILES: Record<string, { minSwitches: number }> = {
  // e2e 那 12 处 = 11 条已搬用例 + 1 格"档位真切了"的探针（探针不算用例，但少它整套做法失去读数）。
  "workers/ai-worker/src/integration-tests/card-generation-v2-e2e-subset.integration.ts": { minSwitches: 25 },
  "workers/ai-worker/src/integration-tests/card-generation-v2-live-progress-postgres.integration.ts": { minSwitches: 6 },
  "workers/ai-worker/src/integration-tests/card-generation-v2-c-cases.integration.ts": { minSwitches: 2 },
};

test("逐用例档位：摘档的那几份都有每发复位，且条数没有缩水", () => {
  for (const [rel, expected] of Object.entries(PER_CASE_SWITCH_FILES)) {
    const source = readFileSync(join(REPO_ROOT, rel), "utf8");
    const switches = [...source.matchAll(/delete process\.env\.CARD_GENERATION_CHAIN/g)].length;
    assert.ok(switches > 0, `${rel} 已经不在台账里了？台账里还有它`);
    assert.ok(/beforeEach\(\(\) => \{ process\.env\.CARD_GENERATION_CHAIN = "v2"; \}\)/.test(source),
      `${rel} 摘了档位却没有每发复位 ⇒ 档位会漏给后面的用例，那些用例绿的是另一条链`);
    assert.ok(switches >= expected.minSwitches,
      `${rel} 的摘档处数从 ${expected.minSwitches} 掉到 ${switches}：有人把用例搬回旧链或删掉了探针，`
      + "要搬回去就把这台账一起改小并写明原因");
    assert.ok(!source.includes("TEMP-REPRO"),
      `${rel} 里留着临时复现用的改动没回：TEMP-REPRO 这类标记不许进版本`);
  }
});
