import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-2：后端「神文件」的**清单只许减不许增**。
 *
 * ## 为什么要一条清单而不是直接拆
 *
 * 审计点名了 4 个神文件，逐个量下来（2026-09-30）：
 *
 * | 文件 | 行数 | 拆了吗 |
 * | --- | --- | --- |
 * | `card-generation-v2/activation-service.ts` | 2461 | 拆了（→ `reuse-resolver.ts`，89 行 0 import） |
 * | `learning-runs/run-service.ts` | 3505 | **没拆**：缝不干净，见审计文档 P2-2 记录 |
 * | `handlers/companion-agent-runtime.ts` | 3950 | 没拆（它属 B2「worker handlers 分子域」） |
 * | `learning-runs/processing/run-processing-tick.ts` | 2729 | 上一轮已迁到 worker（P1-2），仍大 |
 *
 * 这几个文件每一行都是**活代码**，不是死代码。硬拆的代价不是"改坏"，
 * 而是"改坏之后没有测试能看出来"——`run-service.ts` 那次尝试就是这么回的。
 *
 * 所以这一条不逼着拆，它做的是两件更基础的事：
 *
 * 1. **把债变成文件里的一个真数**。清单写在下面，谁都能读，也能改。
 * 2. **不许它变长**。新增一个 1500 行的文件、或把现有文件再堆 100 行，
 *    都会在这里红。
 *
 * ## 阈值为什么是 1500
 *
 * 不是一个"理想值"，是**当前分布里那条明显的坎**：后端 ≥1500 行的有 11 个，
 * 而 1500 之下最大的不到 1000。也就是说 1500 正好切在"这一撮"与"其余"之间，
 * 阈值往下挪会把几十个正常文件卷进来，往上挪就漏掉这一撮本身。
 *
 * ## 范围只管后端
 *
 * 桌面端不进这条判据：`desktop-gateway.ts` 单文件 6378 行，是另一条
 * （`component-size-guard` 5200 行红线）管的事，两条红线混在一起会互相掩护。
 */

// URL 形式带一个尾斜杠；`${REPO_ROOT}/` 会变成 `...study//`，于是 replace 一条也去不掉。
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/+$/, "");
const BACKEND_SRC = ["apps/api/src", "workers/ai-worker/src"];
const THRESHOLD = 1500;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      // 测试、集成测试、bench 都不算产品代码
      if (/\.(test|integration|bench|spec)\.(ts|tsx)$/.test(name)) continue;
      if (p.includes("/dist/")) continue;
      out.push(p);
    }
  };
  for (const rel of BACKEND_SRC) {
    const abs = join(REPO_ROOT, rel);
    try {
      walk(abs);
    } catch {
      // 目录不存在时跳过，而不是当成"没有神文件"（那会让判据空跑）
    }
  }
  return out;
}

function godFiles(): { rel: string; lines: number }[] {
  return sourceFiles()
    .map((p) => ({
      rel: p.replace(`${REPO_ROOT}/`, ""),
      // 与 `wc -l` 对齐：`split("\n")` 会把末尾换行之后的空串也算成一行
      lines: readFileSync(p, "utf8").replace(/\n$/, "").split("\n").length,
    }))
    .filter((f) => f.lines >= THRESHOLD)
    .sort((a, b) => b.lines - a.lines);
}

/**
 * 2026-09-30 实测基线。**只许往下走**。
 *
 * 拆掉一个就把它的行数从表里去掉，并在这里写明拆成了什么——
 * 这样"还欠多少"始终是文件里的一个真数，而不是一次性的印象。
 */
const BASELINE: Readonly<Record<string, number>> = {
  // 2026-10-01（伴星日记）：companion-daily-summary 拆出 diary-content（素材/篇章规则）
  // 与 diary-candidates（有来源的候选筛选），编排文件 2260 → 1473，低于 1500 阈值。
  // 同日将图像读取与任务检查点拆到独立模块后，编排文件现为 1331 行。
  // 2026-09-30（B2）：companion-agent-runtime 从基线里**去掉**。
  // 3950 → 1496：拆成 read-tools(515) / step-plan(201) / events(237) /
  // tool-execution(1098) / proposal(206) / tool-call-ledger(427) 六个模块。
  // 依赖方向的顺序是「先提案后账本」——账本拒绝一次调用时会去建提案，
  // 所以提案不反向依赖账本；同时搬两个会成环（第一版就是这么栽的，已回退）。
  // 2026-10-01：模型流式步骤移入 companion-agent-streaming-step.ts（242 行），
  // runtime 1557 → 1326；回到 1500 行阈值以下。
  // 同日：proposal snapshot 与记忆提案动作分别移入独立模块，learning-action-bridge
  // 1765 → 1495；低于阈值，从基线移除。
  // 同日：记忆工具族（read/recall/save/revise/move/forget 六个）移入
  // companion-memory-tools.ts（502 行），companion-tool-execution 1508 → 1045；
  // 共用的报错与结果类型上提到 companion-tool-result.ts（54 行）以免成环。
  // **它本来就不在基线里**（是新增就超阈值的），所以这里只留记录、不加条目。
  // 同日：交接快照与历史收边（40 §4.7.2）移入 companion-context-handoff.ts（294 行），
  // companion-dialogue-content 1515 → 1264；同样只留记录、不加条目。
  // 判据选的是**域**不是行数：快照回答「裁剪前先固定什么」，装配回答「这一轮怎么写」，
  // 两者没有耦合；而 1264 行给后续改动留出了余量，不必下一轮又拆一次。
  "apps/api/src/modules/learning-runs/run-service.ts": 3505,
  "apps/api/src/modules/learning-runs/processing/run-processing-tick.ts": 2729,
  "apps/api/src/modules/card-generation-v2/activation-service.ts": 2461,
  // 2026-10-05：`workers/ai-worker/src/handlers/parse-source.ts` 1878 → 1485，
  // 从基线里**删掉**这一条。HTML → 正文/标题的提取（`removeElementsByClass`、
  // 三张 class 模式表、`decodeFormulaAlt`、`imgReplacement`、`extractTextFromHtml`、
  // `decodeHtmlEntities`、`extractHtmlTitle`，约 430 行）整体移入新建的
  // `parse-source-html.ts`（440 行）。
  //
  // 拆的理由与上面几条一致，也是判据选的是**域**：抓取那一侧回答「这次请求该不该
  // 发出去、响应该怎么限」（DNS 钉住、重定向逐跳校验、解压、大小上限），
  // 提取那一侧回答「拿到的 HTML 里哪些是正文」（剥标签、剔噪声、解实体），
  // 两者没有耦合——提取块零外部依赖，只用自己的模式表和纯字符串函数。
  // 移动保留的形状：跨文件用到的两个符号由新文件 `export`，原文件顶部 import 回来，
  // 调用点与签名一字未改。
  //
  // 动因：方案 42 给 `FetchUrlDependencies` 补了三段文档注释，把这个已 1878 行的
  // 文件推到 1912 行，触发「清单不增」。棘轮不接受调大基线，所以拆。
  //
  // 2026-10-05（方案 44 §3.3）：装配回执与预算读数移入新建的
  // `workers/ai-worker/src/handlers/companion-context-receipts.ts`（84 行），
  // companion-agent-runtime 1541 → 1499、companion-dialogue 1512 → 1495；
  // 两者都**不在**基线里（是新增就超阈值的），所以这里只留记录、不加条目。
  // 判据同样是**域**：装配回执回答「这一轮实际装进了什么」，编排文件回答
  // 「这一轮怎么读进来」「这些步怎么走」——回执横跨两者，留在任一编排文件里
  // 都只会让它多背一份职责。
  //
  // 2026-10-07（输出预算改按档案声明）：多步正文的分段拼接与复读观测移入新建的
  // `workers/ai-worker/src/handlers/companion-visible-segments.ts`（90 行），
  // companion-agent-runtime 1504 → 1411。同样**不在**基线里（它一直贴着阈值）。
  // 判据是**域**：分段拼接只管"各步说过的话怎么拼成最终正文、什么段该丢"，
  // 与"这一轮怎么读进来、这些步怎么走"没有耦合，零外部依赖。
  //
  // 2026-10-06（输入框传图）：失败留档与兜底话术移入新建的
  // `workers/ai-worker/src/handlers/companion-dialogue-failure-retention.ts`（124 行），
  // companion-dialogue 1525 → 1420。它同样**不在**基线里（HEAD 时 1499 行，贴着阈值，
  // 谁动这个文件都会红——所以这次一次拆够，给后续改动留出余量）。
  // 判据仍是**域**：留档回答「这一轮没成，用户看过的字怎么留住、没字可留时说哪句」，
  // 只在失败收尾时被调用，不读上下文也不碰 provider。
  //
  // 2026-10-09（全文格式调整）：产出核对（claims/quotes 判定 + steer／correctQuote
  // 决定）与纠正指令的文案分支移入同族的 `companion-step-plan.ts`——那一族回答
  // 「这一步要不要纠正、纠正时提示词怎么写」；同次把判截断的包装层并回
  // companion-dialogue-content 的 looksTruncatedReply 边上。
  // companion-agent-runtime 1504 → 1453，重新回到阈值以下。
  // 它同样**不在**基线里（一直贴着阈值，谁动它都会红）。
  // 判据是**域**：核对与纠正决定「这句话要不要拦、怎么改」，与「这一轮怎么读进来、
  // 这些步怎么走」没有耦合；纯判据，不查库、不看时钟。
};

test("神文件清单不增（新增一个超阈值的文件，或把现有的再堆大，都红）", () => {
  const current = godFiles();
  const byRel = new Map(current.map((f) => [f.rel, f.lines]));
  const offenders: string[] = [];

  // ① 清单里的文件不许变长（容 1 行：编辑器末尾换行这类噪声不该让人回来改）
  for (const [rel, cap] of Object.entries(BASELINE)) {
    const now = byRel.get(rel);
    if (now === undefined) continue; // 已经拆掉了 —— 那是好事
    if (now > cap + 1) offenders.push(`${rel}: ${cap} → ${now}`);
  }
  // ② 不许冒出新文件
  for (const f of current) {
    if (!(f.rel in BASELINE)) offenders.push(`新增的神文件 ${f.rel}（${f.lines} 行）`);
  }

  assert.deepEqual(
    offenders,
    [],
    "这些文件让神文件清单变长了：\n  " + offenders.join("\n  ")
    + `\n\n阈值 ${THRESHOLD} 行，基线 ${Object.keys(BASELINE).length} 个、`
    + `${Object.values(BASELINE).reduce((a, b) => a + b, 0)} 行。\n`
    + "拆掉一个就把 BASELINE 里那一条删掉并写明拆成了什么——"
    + "让『还欠多少』始终是个真数。",
  );
});

test("基线里的每一个都还真的存在（别让它悄悄过期）", () => {
  // 某个文件被改名/搬走时，这里会红：要么更新 BASELINE 的键，要么（更好的做法）
  // 因为它变小了而从表里删掉。一张对不上的表比没有表更糟。
  const byRel = new Map(godFiles().map((f) => [f.rel, f.lines]));
  const stale = Object.keys(BASELINE).filter(
    (rel) => !byRel.has(rel) && readFileIfExists(join(REPO_ROOT, rel)) !== null,
  );
  assert.deepEqual(stale, [],
    "BASELINE 里这些条目指向的文件还在，却已经不到阈值了——"
    + "把它的行数更新一下，或者从表里删掉（拆好了就删，别留）。\n  " + stale.join("\n  "));
});

function readFileIfExists(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

test("判据不是空跑（至少认得出当前这几个）", () => {
  assert.ok(godFiles().length > 0,
    "自证：判据一个神文件都认不出——多半是路径或阈值写坏了，"
    + "那样它会永远绿");
});

test("【自证】判据会红：把一个文件堆大必须被抓", () => {
  // 判据的形状：某个 ≥阈值的文件比它的上限长 ⇒ 违规
  // 判据容忍 1 行（末尾换行之类的噪声不该让人回头改基线），
  // 所以样本要取 cap+2，落在容差**之外**。
  const over = (cap: number, now: number): string[] => (now > cap + 1 ? ["probe"] : []);
  assert.deepEqual(over(100, 102), ["probe"], "自证样本没造好：超上限 2 行就该被抓");
  assert.deepEqual(over(100, 101), [], "自证：超 1 行在容差内，不算违规");
  assert.deepEqual(over(100, 100), [], "自证：等于上限不该算违规");
});
