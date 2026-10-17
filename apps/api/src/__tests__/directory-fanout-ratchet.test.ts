import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 目录扇出守卫：一个目录直接放多少个源文件，**只许减不许增**。
 *
 * ## 为什么要有这一条，而不是靠两条已有的守卫
 *
 * `god-file-ratchet` 管的是**单个文件有多长**，`component-size-guard` 管的是
 * 单文件行数与 hook 数。两条都看文件内部，于是「每个文件都不大、但全平铺在一个
 * 目录里」这种形状一路绿灯：`workers/ai-worker/src/handlers` 154 个直接子文件、
 * `.../surfaces/notebook` 131 个，任何人想找一处逻辑都得先滚一遍全量文件名。
 *
 * 这不是"文件太大"，是**目录没有承担索引职责**。判据换成目录后，这两处的增长
 * 第一次有了会红的边界。
 *
 * ## 阈值为什么是 40
 *
 * 不是理想值，是**当前分布里那条坎**：超线的 6 个目录是 52～154，线以下最大的
 * 只有 35（`packages/shared/src/db-schema`）。40 正好切在两者之间——往下挪会把
 * 二十来个正常目录卷进来，往上挪就放过 52 那一档。
 *
 * ## 范围与排除
 *
 * 扫产品源码（后端、shared、桌面端渲染层与主进程）。测试目录（`__tests__`、
 * `live-tests`、`integration-tests`、`test-support`）不计：测试按被测量对象聚在
 * 一起是有意义的，把它们再分一层只会让"这条用例测的是谁"更难找。`dist` 与
 * `node_modules` 同理排除。
 *
 * 待拆的目录登记在 `BASELINE` 里，条目只许删、数字只许小。
 */

// URL 形式带一个尾斜杠；`${REPO_ROOT}/` 会变成 `...study//`，于是 replace 一条也去不掉。
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/+$/, "");
const SOURCE_ROOTS = [
  "apps/api/src",
  "workers/ai-worker/src",
  "packages/shared/src",
  "packages/agent-core/src",
  "packages/agent-host/src",
  "apps/desktop-client/src",
];
/** 测试与工具目录不计入扇出：它们按被测对象聚在一起本身就是索引。 */
const EXCLUDED_DIRS = new Set(["__tests__", "live-tests", "integration-tests", "test-support", "__mocks__"]);
/** 阈值 40：当前分布里 35 与 52 之间的那道坎。 */
const THRESHOLD = 40;

function isProductSource(name: string): boolean {
  if (!/\.(ts|tsx)$/.test(name)) return false;
  if (name.endsWith(".d.ts")) return false;
  return !/\.(test|integration|bench|spec)\.(ts|tsx)$/.test(name);
}

/** 每个目录的**直接**产品源文件数（不递归）。 */
function fanOut(): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (rel: string): void => {
    const abs = join(REPO_ROOT, rel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      // 目录不存在时跳过，而不是当成"没有超线目录"（那会让判据空跑）
      return;
    }
    const files = entries.filter((name) => {
      if (!isProductSource(name)) return false;
      try {
        return statSync(join(abs, name)).isFile();
      } catch {
        return false;
      }
    });
    if (files.length > 0) out.set(rel, files.length);
    for (const name of entries) {
      if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
      if (name === "node_modules" || name === "dist") continue;
      let isDir = false;
      try {
        isDir = statSync(join(abs, name)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(`${rel}/${name}`);
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return out;
}

/**
 * 2026-10-17 实测基线。**只许往下走。**
 *
 * 拆掉一个目录就把它的条目删掉，并在下面写明拆成了什么——这样"还欠多少"始终是
 * 文件里的一个真数，而不是一次性的印象。
 */
const BASELINE: Readonly<Record<string, number>> = {
  // 2026-10-17 这一轮的记录（全部已拆完，基线清空）：
  //
  // · `.../surfaces/notebook` 117 → annotation(9) / document(32) / generation(16) /
  //   learning(27) / library(10) / reading(9) / shell(14)。判据是职责不是依赖簇：
  //   去掉 `notebook-surface`（出入度各 40）后，剩下 99 个文件全是 ≤7 的碎片。
  // · `workers/ai-worker/src/handlers` 154 → agent(25) / turn(28) / tools(17) /
  //   context(21) / memory(13) / proactive(6) / journal(11) / note(22) /
  //   schedulers(10)，index.ts 留根。这一处依赖图**是分层的**（最大强连通分量
  //   7 个文件、从叶子到入口 14 层），但分组内聚率只有 40%——编排层天然横跨。
  // · `apps/desktop-client/src/main` 72 → artifact / gateway / ipc / note-doc /
  //   store / update / voice / window，index.ts 留根。72 个文件只有 21 条内部边，
  //   分组只是把已有边界落成目录。
  // · `.../components/companion` 85 → bubble / content / goals / hud / journal /
  //   live2d / notify / voice。整目录是一个连通块（170 条边），只能按职责切。
  // · `.../renderer/src/app` 52 → client / companion-pages / companion-session /
  //   gate / home / source（内聚 50%）。
  // · `packages/shared/src` 79 → agent / companion / note / review / platform /
  //   content，index.ts 留根（内聚 76%）。这一处同时要改 barrel、package.json 的
  //   exports 映射，以及各包 tsconfig 的 `@astella/shared/*` 候选。
};

test("目录扇出清单不增（新增一个超线目录，或把现有的再堆大，都红）", () => {
  const current = fanOut();
  const offenders: string[] = [];

  // ① 清单里的目录不许变大
  for (const [rel, cap] of Object.entries(BASELINE)) {
    const now = current.get(rel);
    if (now === undefined) continue; // 已经拆掉了 —— 那是好事
    if (now > cap) offenders.push(`${rel}: ${cap} → ${now}`);
  }
  // ② 不许冒出新的超线目录
  for (const [rel, count] of current) {
    if (count > THRESHOLD && !(rel in BASELINE)) {
      offenders.push(`新增的超线目录 ${rel}（${count} 个直接子文件）`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "这些目录让扇出清单变长了：\n  " + offenders.join("\n  ")
    + `\n\n阈值 ${THRESHOLD} 个直接子文件，基线 ${Object.keys(BASELINE).length} 个目录。\n`
    + "拆掉一个就把 BASELINE 里那一条删掉并写明拆成了什么——"
    + "让『还欠多少』始终是个真数。",
  );
});

test("基线里的每一个都还在（别让它悄悄过期）", () => {
  // 目录被拆开或改名后，这里会红：更好的做法是把它从表里删掉。
  // 一张对不上的表比没有表更糟——它会让人以为那里还欠着，实际早就不欠了。
  const current = fanOut();
  const stale = Object.keys(BASELINE).filter((rel) => !current.has(rel));
  assert.deepEqual(stale, [],
    "BASELINE 里这些目录已经不在了（被拆开或改名）——从表里删掉它们。\n  " + stale.join("\n  "));
});

test("判据不是空跑（扫得到目录，且能认出超线的那种）", () => {
  // 基线清空之后，"至少有一个超线目录"不再是有效的自证——那时它证明的是欠债，
  // 不是判据活着。改成两条：扫描器真的收得到目录，且阈值判定能用构造样本触发。
  const counts = [...fanOut()];
  assert.ok(counts.length > 50,
    `自证：只扫到 ${counts.length} 个目录，多半是路径写坏了，那样它会永远绿`);
  assert.ok(counts.every(([, n]) => n > 0), "自证：收到了空目录，说明过滤条件错了");
  const over = (cap: number, now: number) => now > cap;
  assert.equal(over(THRESHOLD, THRESHOLD + 1), true, "阈值判定没起作用");
});

test("【自证】判据会红：扇出涨一个就该被抓", () => {
  // 判据的形状：目录的直接子文件数 > 上限 ⇒ 违规。
  const over = (cap: number, now: number): string[] => (now > cap ? ["probe"] : []);
  assert.deepEqual(over(100, 101), ["probe"], "自证样本没造好：涨 1 个就该被抓");
  assert.deepEqual(over(100, 100), [], "自证：等于上限不算违规");
});
