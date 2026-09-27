/**
 * 制卡链入口台账（39d W7-1／W7-7 刀一建立，刀二改成"只此一档"的形状）。
 *
 * 这份守卫盯的是**入口与链的关系**。它先后管过两件不同的事：
 *
 * 1. 刀一之前：总控 `CARD_GENERATION_CHAIN` 只管第一次生成那一发，而它当时是
 *    `generation-run-service` 的模块私有函数——审核台上的四发与"再生成一次"绕开它
 *    直接投旧链的 jobType。后果不是"多跑一次旧链"这么简单：一条新链 run 会被旧四阶段链
 *    重新规划，同一篇笔记上两批候选来自两条链，而"切换完成"看上去只取决于那个开关。
 *    刀一判"每一发都得问过总控"，刀二把旧链与开关一起删掉，于是这一格变成
 *    **六个入口、每处一个 jobType**：多一处没登记、某一处消失了没把台账改短、
 *    或者谁把 `? 新链 : 旧链` 那种三元写回来，都红。
 * 2. 另一件到今天为止更硬的事：**旧链的四个 jobType 名字在整棵源码树里不该再出现**。
 *    队列只认 `case` 里那三种，投出旧名字的作业会被判成 unknown jobType 并把 run 打成
 *    needs_attention——那是"要真跑一次才发现"的错，所以要静态读得出。
 *
 * 清单只许变短（与 `integration-run-registration.test.ts` 同法）：某一处消失了却没把
 * 台账改短 ⇒ 红，因为台账留在原地就是它在说谎。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const API_ROOT = "apps/api/src";
const V3_TASKS_FILE = "workers/ai-worker/src/card-generation-v3/tasks.ts";
const DISPATCHER_FILE = "workers/ai-worker/src/handlers/card-generation-v2-handler.ts";

/** 简化链的两种 job（整批／逐候选）。六个入口只能投这两个。 */
const SIMPLIFIED_JOB_TYPES = ["card_generation_simplified_v1", "card_candidate_refine_v3"];

/** 已删除的四阶段链的 jobType。出现任何一处都是红——包括注释里"照着抄回来"的诱惑。 */
/**
 * 已删除的四阶段链的 jobType。代码里出现任何一处都是红：分发点只认下面那两种 job，
 * 投出旧名字的作业会被判成 unknown jobType，并把 run 打成 needs_attention。
 *
 * 名字按前缀＋后缀拼出来，不写成整串字面量——这份台账本身就是"旧名字为什么不该再出现"
 * 的说明文本，整串写在这里会让下面那条扫描第一天就红在自己身上（拼接不影响扫描结果：
 * 扫的是各文件里的**整串**出现）。
 */
const RETIRED_JOB_TYPES = ["plan", "replan_set", "recheck_candidate", "regenerate_candidate"]
  .map((suffix) => `card_generation_${suffix}`);

/**
 * 随旧链一起删掉的总控开关名。同样按两段拼出来（与上面那四个 jobType 一个道理：
 * 台账自己不能成为它要拦的那次命中）。
 */
const RETIRED_SWITCH_ENV = "CARD_GENERATION_" + "CHAIN";

/**
 * 每一个投进制卡 outbox 的入口，逐条写明是哪一发。
 * 值 = 该文件里那些入队点的 jobType，按源码出现顺序，**每处一个字面量**。
 */
const ENTRY_JOB_TYPES: Record<string, string[]> = {
  "apps/api/src/modules/card-generation-v2/candidate-review-service.ts": [
    // 编辑后重检、合并后重检、按反馈重生成（逐候选那一发），与整批重规划。
    "card_candidate_refine_v3", "card_candidate_refine_v3",
    "card_candidate_refine_v3", "card_generation_simplified_v1",
  ],
  "apps/api/src/modules/card-generation-v2/generation-run-service.ts": [
    // 第一次生成，与质量门全失败后的"再生成一次"（同一 jobType，payload 里带 mode 区分来意）。
    "card_generation_simplified_v1", "card_generation_simplified_v1",
  ],
};

/** 与链无关的那一发（不做语义调用，只投投影消费），登记它是为了说明「看过、不算漏」。 */
const CHAIN_AGNOSTIC_ENTRIES: Record<string, string[]> = {
  "apps/api/src/modules/card-generation-v2/activation-service.ts": ["card_v2_post_activation"],
};

/** 简化链已定义的任务（`tasks.ts` 里那几个 `id`）。 */
const V3_TASK_IDS = ["card_generate_v3", "card_content_check_v3", "card_candidate_rewrite_v3"];
/**
 * 三个任务都**没有**独立的 outbox 入队点，也都不该有：生成与检查由整批那一发串起来
 * 跑，改写由"检查判 rewrite"与"用户点重生成"两条路各自逐张调用（W7-7 刀一）。
 */
const V3_TASKS_CHAINED_INSIDE_A_JOB = new Set(V3_TASK_IDS);

type Site = { file: string; literals: string[] };

/**
 * 采集一个文件里所有制卡 outbox 入队点。
 *
 * 判据锚的是 `.insert(cardGenerationRunOutboxV2)` 那一发语句里的 `jobType:`，不是随便一个
 * 同名字段（别的表也可能有）。**一条 jobType 表达式里只许有一个字面量**——出现两个就是
 * 有人把"问开关挑档"那件已经不存在的事写回来了；取值写成变量式（`jobType: jt`）收进来
 * 时带 `变量:` 前缀，台账里对不上就是红，逼着改的人显式登记。
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
    sites.push({ file, literals });
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

/** 带引号的整串：单引号（SQL 里）与双引号（TS 字面量里）两种都算。 */
function quotedLiteral(name: string): RegExp {
  return new RegExp(`["'\`]${name}["'\`]`);
}

/**
 * 全仓扫一个 pattern，返回 `文件:行号` 命中清单（只扫源码树，不扫文档与归档）。
 *
 * 只扫**代码行**：`//`、` * `（块注释体）与 `/*` 开头的行先丢掉。这里要判的是"不许再把
 * 旧名字写进代码"，而历史原因写在注释里是这份守卫自己要留的证据（它自己就满篇旧名字），
 * 所以按整行注释剥一遍——不然这条判据第一天就红在自己的说明上。
 *
 * `packages/shared/src/db-schema/` 整目录跳过：那份文件是**已提交迁移的 1:1 镜像**，
 * 里面那句 `'card_generation_plan'` 是迁移 0163 的部分唯一索引谓词（现在没人写那一档了，
 * 但改它要新迁移＋动 journal，是另一刀；已登记在 39d-w71 §7.4 末）。镜像与迁移不一致
 * 比"旧名字出现在谓词里"严重得多，不能靠改这份文件让扫描变绿。
 */
function findPatternHits(pattern: RegExp): string[] {
  const roots = ["apps/api/src", "apps/desktop-client/src", "workers/ai-worker/src", "packages/shared/src"];
  const hits: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, rel))) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = `${rel}/${entry}`;
      if (statSync(join(REPO_ROOT, child)).isDirectory()) {
        if (child !== "packages/shared/src/db-schema") walk(child);
        continue;
      }
      if (!/\.(ts|tsx|mjs)$/.test(entry)) continue;
      readFileSync(join(REPO_ROOT, child), "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
        if (pattern.test(line)) hits.push(`${child}:${index + 1}`);
      });
    }
  };
  roots.forEach(walk);
  return hits;
}

test("分母自证：真读到了那六个入口，且每一处都只有一个 jobType", () => {
  const sites = allSites();
  assert.equal(sites.length, 7,
    `读到 ${sites.length} 个制卡 outbox 入队点（六个链入口＋一发与链无关的投影）：walk 或判据坏了`);
  for (const site of sites) {
    assert.equal(site.literals.length, 1,
      `${site.file} 那一发的 jobType 表达式里有 ${site.literals.length} 个字面量`
      + `（${site.literals.join(" / ")}）：挑档那件事已经没有第二个答案了`);
  }
});

test("六个入口排出去的都是简化链的两种 job", () => {
  for (const site of allSites()) {
    const [literal] = site.literals;
    const chainAgnostic = CHAIN_AGNOSTIC_ENTRIES[site.file]?.includes(literal);
    assert.ok(chainAgnostic || SIMPLIFIED_JOB_TYPES.includes(literal),
      `${site.file} 那一发排的是 ${String(literal)}，既不是简化链的 job，也没登记成「与链无关」`);
  }
});

test("已随链删除的四个 jobType 与总控开关名，在源码里一处都不许留", () => {
  // 反向判据要有正控制，否则"扫不到东西"与"扫了但没有"读起来一样：先证明
  // `findPatternHits` 真的读到了那些文件——拿六个入口自己在用的 jobType 名字试一遍。
  for (const present of SIMPLIFIED_JOB_TYPES) {
    assert.ok(findPatternHits(quotedLiteral(present)).length > 0,
      `探针用的字面量 ${present} 都扫不到 ⇒ 这条判据读不到东西，"没有旧名字"是假的`);
  }
  for (const retired of RETIRED_JOB_TYPES) {
    // 按**带引号的整串**匹配：`card_generation_plan` 是 `card_generation_plans_v2`
    // （那张还在用的表名）的前缀，只匹配名字会把每次读表都报成违规。
    const hits = findPatternHits(quotedLiteral(retired));
    assert.deepEqual(hits, [],
      `${retired} 还留在源码里（${hits.slice(0, 5).join("，")}）：投出去就是 unknown jobType，`
      + "会把 run 打成 needs_attention");
  }
  const envHits = findPatternHits(new RegExp(`\\b${RETIRED_SWITCH_ENV}\\b`));
  assert.deepEqual(envHits, [],
    `总控 ${RETIRED_SWITCH_ENV} 又被写回代码里了（${envHits.slice(0, 5).join("，")}）：`
    + "旧链与它一起删除，没有第二档可挑");
});

test("入口台账：多一处没登记、或某一处消失了却没把清单改短，都红", () => {
  const grouped = groupByFile(allSites());
  const expected = { ...ENTRY_JOB_TYPES, ...CHAIN_AGNOSTIC_ENTRIES };
  for (const [file, literals] of Object.entries(expected)) {
    assert.deepEqual(grouped[file] ?? [], literals,
      `${file} 的入队台账与代码不一致（台账记的是 ${JSON.stringify(literals)}）。`
        + "少一处就删掉对应那一格（清单只许变短）；新加了入口先登记是哪一发。");
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
  // run 打成 needs_attention）。
  const dispatcher = readFileSync(join(REPO_ROOT, DISPATCHER_FILE), "utf8");
  for (const jobType of SIMPLIFIED_JOB_TYPES) {
    assert.match(dispatcher, new RegExp(`case "${jobType}"`), `${jobType} 投出去没有分发点接`);
  }
  const handler = readFileSync(join(REPO_ROOT, "workers/ai-worker/src/card-generation-v3/handler.ts"), "utf8");
  assert.match(handler, /export async function processCardGenerationSimplifiedJob/, "整批那一发的处理函数不见了");
  assert.match(handler, /export async function processCardCandidateRefineV3Job/, "逐候选那一发的处理函数不见了");
});

test("判据本身灵敏：一个字面量、两个字面量、变量式、别的表，四种写法各判各的", () => {
  const plain = `await tx.insert(cardGenerationRunOutboxV2).values({\n  jobType: "card_candidate_refine_v3",\n  status: "pending",\n})`;
  assert.deepEqual(enqueueSitesIn("f.ts", plain).map((s) => s.literals),
    [["card_candidate_refine_v3"]], "单个字面量没收进来 ⇒ 台账会漏登记");

  const RETIRED_EXAMPLE = RETIRED_JOB_TYPES[2]; // …_recheck_candidate，按上面同一拼法取
  const ternary = `await tx.insert(cardGenerationRunOutboxV2).values({\n  jobType: someGate() ? "card_candidate_refine_v3" : "${RETIRED_EXAMPLE}",\n  status: "pending",\n})`;
  const [ternarySite] = enqueueSitesIn("f.ts", ternary);
  assert.deepEqual(ternarySite?.literals,
    ["card_candidate_refine_v3", RETIRED_EXAMPLE],
    "两档没被收进来 ⇒ 上面那条「每处只有一个」判据恒真");
  assert.equal(allSites().every((s) => s.literals.length === 1) && ternarySite.literals.length === 2, true,
    "这条判据读不出「两个字面量」那种写法，就是没在读");

  const viaVar = `const jt = "x";\nawait tx.insert(cardGenerationRunOutboxV2).values({\n  runId,\n  jobType: jt,\n  status: "pending",\n})`;
  assert.deepEqual(enqueueSitesIn("f.ts", viaVar).map((s) => s.literals), [["变量:jt"]],
    "写成变量式时要显式露出来（对不上台账就红），不许静默当成合法一档");

  const otherTable = `await tx.insert(someOtherOutbox).values({\n  jobType: "unrelated",\n  status: "pending",\n})`;
  assert.deepEqual(enqueueSitesIn("f.ts", otherTable), [],
    "别的表的 jobType 也被收进来了 ⇒ 台账会被不相干的功能误伤");
});
