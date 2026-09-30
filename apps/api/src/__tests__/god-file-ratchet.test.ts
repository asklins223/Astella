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
  // 2026-09-30（B2）：companion-agent-runtime 从基线里**去掉**。
  // 3950 → 1496：拆成 read-tools(515) / step-plan(201) / events(237) /
  // tool-execution(1098) / proposal(206) / tool-call-ledger(427) 六个模块。
  // 依赖方向的顺序是「先提案后账本」——账本拒绝一次调用时会去建提案，
  // 所以提案不反向依赖账本；同时搬两个会成环（第一版就是这么栽的，已回退）。
  "apps/api/src/modules/learning-runs/run-service.ts": 3505,
  "apps/api/src/modules/learning-runs/processing/run-processing-tick.ts": 2729,
  "apps/api/src/modules/card-generation-v2/activation-service.ts": 2461,
  "workers/ai-worker/src/handlers/parse-source.ts": 1878,
  "workers/ai-worker/src/handlers/companion-daily-summary.ts": 1784,
  "apps/api/src/modules/companion-conversation/learning-action-bridge.ts": 1705,
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
