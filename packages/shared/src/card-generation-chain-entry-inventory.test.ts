/**
 * 制卡链切换的入口台账（39d W7-1／W7-7）。
 *
 * 为什么这条要常驻：入口总控 `CARD_GENERATION_CHAIN` 只管到**第一次生成**那一发
 * （`generation-run-service.ts` 里唯一一处 `simplifiedChainEnabledV3()`）。审核台上的另外几发
 * ——编辑后重检、合并后重检、反馈重生成、整批重规划、质量门失败后「再生成一次」——至今直接投
 * 旧链的 jobType，而那个总控函数是**模块私有**的（没 export），那些入口连问一句都问不到。
 * 后果不是「多跑一次旧链」这么简单：一条新链 run 会被旧四阶段链重新规划，于是同一篇笔记上
 * 两批候选来自两条链，而「切换完成」看上去只取决于那个开关。
 *
 * 所以这里不判「开关对不对」，判**台账**：每一个投进制卡 outbox 的 jobType 都要被归类。
 * 新增一处没归类 ⇒ 红；某一处翻进新链了却没把清单改短 ⇒ 也红（清单留在原地就是台账在说谎，
 * 与 `integration-run-registration.test.ts` 同法）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const API_ROOT = "apps/api/src";
const V3_TASKS_FILE = "workers/ai-worker/src/card-generation-v3/tasks.ts";
const GATE_FN = "simplifiedChainEnabledV3";

/** 今天唯一问过总控的入口所在文件（第一发生成）。 */
const HONORED_FILE = "apps/api/src/modules/card-generation-v2/generation-run-service.ts";

/**
 * 仍直接投旧链的入口，逐条写明是哪一发。W7-7 的活清单：翻一格删一条。
 * 值 = 该文件里那些入队点的 jobType，按源码出现顺序。
 */
const OLD_CHAIN_ENTRIES: Record<string, string[]> = {
  // §12.2／§17.4：审核台上的四发（编辑重检、合并重检、反馈重生成、整批重规划）。
  "apps/api/src/modules/card-generation-v2/candidate-review-service.ts": [
    "card_generation_recheck_candidate",
    "card_generation_recheck_candidate",
    "card_generation_regenerate_candidate",
    "card_generation_replan_set",
  ],
  // 质量门全失败之后用户点「再生成一次」：复用旧链的整批重规划。
  "apps/api/src/modules/card-generation-v2/generation-run-service.ts": [
    "card_generation_replan_set",
  ],
};

/** 与链无关的那一发（不做语义调用，只投投影消费），登记它是为了说明「看过、不算漏」。 */
const CHAIN_AGNOSTIC_ENTRIES: Record<string, string[]> = {
  "apps/api/src/modules/card-generation-v2/activation-service.ts": ["card_v2_post_activation"],
};

/** 简化链已定义的任务（`tasks.ts` 里那几个 `id`），台账必须逐一对得上。 */
const V3_TASK_IDS = ["card_generate_v3", "card_content_check_v3", "card_candidate_rewrite_v3"];
/** 由简化 job 内部串起来跑的两次语义调用——它们本来就不该有独立入队点。 */
const CHAINED_INSIDE_SIMPLIFIED_JOB = new Set(["card_generate_v3", "card_content_check_v3"]);
/** 新链的 jobType：必须至少有一处在投（否则整个开关是空的）。 */
const SIMPLIFIED_JOB_TYPES_NEEDING_ENTRY = ["card_generation_simplified_v1"];
/** 刀c 落的是任务与 handler；谁投它归 W7-7（审核台上「改写这一张」那一发）。 */
const V3_TASKS_WITHOUT_ENTRY = new Set(["card_candidate_rewrite_v3"]);

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

test("分母自证：真读到了那些入队点，也认得出「问过总控」那两种写法", () => {
  const sites = allSites();
  assert.ok(sites.length >= 6, `只读到 ${sites.length} 个制卡 outbox 入队点：walk 或判据坏了，后面的归类就空转`);
  const honoring = sites.filter((s) => s.honoring);
  assert.equal(honoring.length, 1,
    `今天该恰好一处问过总控（第一次生成那一发）。实际 ${honoring.length} 处：${honoring.map((s) => `${s.file}→${s.literals.join("/")}`).join("，")}`);
  assert.equal(honoring[0]?.file, HONORED_FILE, "问过总控的那一处换了文件，台账要跟着改");
  // 那一发必须**两档都还在**：删掉缺省那一档＝开关失去"回到改前行为"的能力。
  assert.deepEqual(honoring[0]?.literals.sort(),
    ["card_generation_plan", "card_generation_simplified_v1"],
    "开关那一发不再同时给出新旧两档：`off` 档要能完全回到改前行为");
});

test("旧链入口台账：多一处没登记、或翻进新链却没删条目，都红", () => {
  const grouped = groupByFile(allSites().filter((s) => !s.honoring));
  const expected = { ...OLD_CHAIN_ENTRIES, ...CHAIN_AGNOSTIC_ENTRIES };
  for (const [file, literals] of Object.entries(expected)) {
    assert.deepEqual(grouped[file] ?? [], literals,
      `${file} 的入队台账与代码不一致（台账记的是 ${JSON.stringify(literals)}）。`
        + "翻了那一格就把对应那条删掉；新加了入口先登记是哪一发。");
  }
  const stray = Object.entries(grouped)
    .filter(([file]) => !(file in expected))
    .map(([file, list]) => `${file} → ${list.join("，")}`);
  assert.deepEqual(stray, [], `出现没登记的制卡 outbox 入口：${stray.join("；")}`);
});

test("V3 任务与 jobType 的入口台账：简化链 jobType 有入口，改写任务还没有，各自写明白", () => {
  // ① 新链的 jobType 必须真的有人在投（今天那一处问过总控的就是它）。
  const literals = new Set(allSites().flatMap((s) => s.literals));
  for (const jobType of SIMPLIFIED_JOB_TYPES_NEEDING_ENTRY) {
    assert.ok(literals.has(jobType),
      `简化链的 jobType ${jobType} 没有任何入队点了——开关那一发被删了？那就把这条台账一起删`);
  }
  // ② 任务定义只能加减在台账里：tasks.ts 里现在有哪几个，逐字对账。
  const tasks = readFileSync(join(REPO_ROOT, V3_TASKS_FILE), "utf8");
  const defined = [...tasks.matchAll(/\bid:\s*"([a-z0-9_]+_v3)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, [...V3_TASK_IDS].sort(),
    `tasks.ts 里的任务定义与台账对不上（实际 ${defined.join("，") || "空"}）：新加任务要在这里登记它谁投`);
  // ③ 每个任务要么有出网的入队点，要么写清「不需要入口」／「还没有入口」。
  for (const id of defined) {
    const hasEntry = literals.has(id);
    if (CHAINED_INSIDE_SIMPLIFIED_JOB.has(id)) {
      assert.ok(!hasEntry,
        `${id} 今天是被简化 job 内部串起来跑的；哪天它有了独立入队点，就把这条从「不需要入口」里删掉`);
      continue;
    }
    if (!hasEntry) {
      assert.ok(V3_TASKS_WITHOUT_ENTRY.has(id),
        `${id} 定义了却没有任何入口，也没登记：要么接上，要么写明等谁接线（W7-7）`);
      continue;
    }
    assert.ok(!V3_TASKS_WITHOUT_ENTRY.has(id),
      `${id} 已经有入队点了，把「还没有入口」清单里那一条删掉`);
  }
});

test("判据本身灵敏：三元、变量式、没问过总控，三种写法各判各的", () => {
  const ternary = `await tx.insert(cardGenerationRunOutboxV2).values({\n  jobType: ${GATE_FN}() ? "card_generation_simplified_v1" : "card_generation_plan",\n  status: "pending",\n})`;
  const viaVar = `const jt = ${GATE_FN}() ? "a" : "card_generation_replan_set";\nawait tx.insert(cardGenerationRunOutboxV2).values({\n  runId,\n  jobType: jt,\n  status: "pending",\n})`;
  const plain = `await tx.insert(cardGenerationRunOutboxV2).values({\n  jobType: "card_generation_recheck_candidate",\n  status: "pending",\n})`;
  const otherTable = `await tx.insert(someOtherOutbox).values({\n  jobType: "unrelated",\n  status: "pending",\n})`;
  assert.equal(enqueueSitesIn("f.ts", ternary).filter((s) => s.honoring).length, 1,
    "三元写在行内却没被认出来");
  assert.equal(enqueueSitesIn("f.ts", viaVar).filter((s) => s.honoring).length, 1,
    "先算好变量再写 `jobType: jt` 没被认出来 ⇒ 真实代码改成变量式就会漏判");
  assert.deepEqual(enqueueSitesIn("f.ts", plain).filter((s) => s.honoring), [],
    "什么都没问却被判成问过总控 ⇒ 判据恒真");
  assert.deepEqual(enqueueSitesIn("f.ts", otherTable), [],
    "别的表的 jobType 也被收进来了 ⇒ 台账会被不相干的功能误伤");
});
