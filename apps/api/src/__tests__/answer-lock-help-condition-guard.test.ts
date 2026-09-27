/**
 * §14.1.1「**以回答锁定先后为界**」的执法点不许被压回 boolean（39d W5-1 主体刀一 · 守卫）。
 *
 * 2026-09-27 量到的实情：
 *  - `run-processing-tick.ts` 里那个对账读点（读 `learning_artifacts.lockedAt` 与
 *    `learning_exposures_v2`）**返回 boolean**——"锁定前呈现过帮助"与
 *    "**判不出**有没有呈现过帮助"被压成同一个 `false`；
 *  - 而那个 `false` 的下游是 `unassistedEligibleAfter: null`，语义是
 *    「没有需要冷却的帮助」＝「这次是独立表现」；
 *  - §14.1.1 明写：一直无法对账时「保留回答但**不签发独立证据**」。
 *
 * 也就是说，今天系统**判不出**这次作答有没有被帮助，而它把这件事当成了**没有被帮助**。
 * 修它要改 `run-processing-tick.ts`（接线归 W5-1 主体刀二），而那个文件本轮正在被
 * 另一路编辑——**改不得**。
 *
 * **这一条为什么不写成"直接断言已修"**：明知它红还留在套件里，等于教所有人忽略红色，
 * 也会让 CI 一直红着。所以这里交付的不是修复，是三件能在**不修复**的前提下守住的事：
 *  1. 共享那一份判据的四档与常量边界不许烂掉（它是修复要接上去的那一头）；
 *  2. **半迁移不许发生**：接线一旦开始就不能停在"调了判据却还留着那个 boolean"；
 *     这一条在**没接**和**接完**两种状态下都是绿的，所以接的人不必先来改这条测试；
 *  3. 这个缺陷必须**被记在案**（台账 §19 有那一行），否则它会在下一次重构里被忘掉。
 *
 * 形状与本仓其他守卫一致：扫源码、按**就近**窗口找判据调用。
 * 为什么值得写：§14.1.1 那句话的正确性完全落在"压不压"这一个形状上——
 * 压了之后**没有任何类型会报错、没有任何现有单测会红**，只有读产品的人才发现得了。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  decideHelpConditionV2,
  helpConditionCountsAsIndependentV2,
  unreconcilableDispositionV2,
} from "@ailearn/shared/help-condition-rules-v2";

const API_ROOT = resolve(import.meta.dirname, "..");
// API_ROOT = apps/api/src → 往上三级是仓库根
const REPO_ROOT = resolve(API_ROOT, "..", "..", "..");
const TICK = join(API_ROOT, "modules", "learning-runs", "run-processing-tick.ts");
const LEDGER = join(
  REPO_ROOT,
  "docs",
  "plans",
  "learning-companion",
  "39d-implementation-task-breakdown-2026-09-24.md",
);

/** 与 `note-visibility-read-sites` 同一份剥法：注释里提到一个词不该改变判定。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 走遍 learning-runs 下的源文件（测试与集成测试不参与）。 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith(".ts")) continue;
      if (/(\.test|\.integration)\.ts$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(join(API_ROOT, "modules", "learning-runs"));
  return out;
}

const tickSource = stripComments(readFileSync(TICK, "utf8"));
const tickIsMigrated = tickSource.includes("decideHelpConditionV2");

test("判据那一头不许烂：四档齐、且「判不出来」不签发独立证据", () => {
  const lock = new Date("2026-09-27T10:00:00.000Z");
  const before = new Date("2026-09-27T09:00:00.000Z");
  const after = new Date("2026-09-27T10:05:00.000Z");

  assert.equal(
    decideHelpConditionV2({ answerLockedAt: lock, helpRequestedAt: null, helpPresentedAt: null, reconcilable: false }),
    "independent",
  );
  assert.equal(
    decideHelpConditionV2({ answerLockedAt: lock, helpRequestedAt: before, helpPresentedAt: before, reconcilable: false }),
    "assisted",
  );
  // 呈现回执没对上、或"更晚才到"——两档都不许翻成独立（§14.1.1 点名不许只凭客户端时间判）。
  for (const presented of [null, after]) {
    const condition = decideHelpConditionV2({
      answerLockedAt: lock, helpRequestedAt: before, helpPresentedAt: presented, reconcilable: false,
    });
    assert.equal(helpConditionCountsAsIndependentV2(condition), false,
      `呈现回执=${presented?.toISOString() ?? "null"} 这一档翻成了独立`);
  }
  assert.equal(
    decideHelpConditionV2({ answerLockedAt: null, helpRequestedAt: null, helpPresentedAt: null, reconcilable: false }),
    "unknown_no_evidence",
  );

  // 那一档的四条常量边界。
  const d = unreconcilableDispositionV2();
  assert.equal(d.keepsAnswer, true);
  assert.equal(d.issuesIndependentEvidence, false);
  assert.equal(d.autoSignsFromSelfReport, false);
  assert.equal(d.blocksForever, false);
  assert.equal(d.freshAttemptsAllowed, 1);
  assert.equal(d.userFacingLabel, "帮助条件无法确认");
});

test("半迁移不许发生：接了判据就不能还留着那个 boolean（这一条在两种状态下都绿）", () => {
  if (!tickIsMigrated) {
    // 还没接：这一条什么都不用断言，但要把**为什么现在还红着**说清，免得被当成漏写。
    assert.ok(
      tickSource.includes("lockedAt") && tickSource.includes("learningExposuresV2"),
      "tick 里已经不读 lockedAt / exposure 了——那么要么已接（该走另一支），要么这个缺陷变了形状，请回来重读这一条",
    );
    return;
  }
  // 接了之后：那个把「读不到回执」压成 `false` 的形状必须一起消失。
  assert.ok(
    !/if\s*\(\s*!\s*last[A-Za-z]*\s*\)\s*return\s*false\s*;/.test(tickSource),
    "已经接上 `decideHelpConditionV2` 了，但「读不到暴露回执就当没有帮助」那一行还在——"
    + "半迁移会让新判据被旧形状旁路掉（§14.1.1 的问题原封不动地留着）",
  );
});

test("这个缺陷必须被记在案：台账 §19 有 W5-1 主体刀一那一行", () => {
  const ledger = readFileSync(LEDGER, "utf8");
  assert.ok(
    ledger.includes("W5-1 主体刀一") && ledger.includes("帮助条件"),
    "台账 §19 里找不到 W5-1 主体刀一那一行：这个缺陷没有被记下来，"
    + "下一次重构就会把它忘掉（它是静默失效的——没有任何类型或现有单测会报）",
  );
});

test("判据自己的灵敏度：boolean 形状的合成样本与接上判据的样本必须分得开", () => {
  const booleanShaped = `
    async function reconcileIt(tx, command) {
      const lockedAt = await readLockedAt(tx, command.artifactId);
      if (!lockedAt) return false;
      const rows = await tx.select({ exposedAt: learningExposuresV2.exposedAt })
        .from(learningExposuresV2).where(eq(learningExposuresV2.objectiveId, id));
      const last = rows[0]?.exposedAt ?? null;
      if (!last) return false;
      const gapMs = lockedAt.getTime() - last.getTime();
      return gapMs >= 0 && gapMs < WINDOW;
    }`;
  const migrated = booleanShaped.replace(
    "      return gapMs >= 0 && gapMs < WINDOW;",
    "      return decideHelpConditionV2({ answerLockedAt: lockedAt, helpRequestedAt: last, helpPresentedAt: last, reconcilable: true });",
  );
  const judge = (src: string) => src.includes("decideHelpConditionV2");
  assert.equal(judge(booleanShaped), false, "boolean 形状被判成了已接——守卫瞎了");
  assert.equal(judge(migrated), true, "接上判据的样本没被判成已接——守卫瞎了");
  // 合成样本里确实藏着「读不到回执就当没有帮助」那一格，否则灵敏度量不到东西。
  assert.ok(booleanShaped.includes("if (!last) return false;"));
  // 而半迁移检查要能抓到"接了判据却留着那一行"。
  const half = migrated.replace("      if (!last) return false;", "      if (!last) return false;");
  assert.ok(
    /if\s*\(\s*!\s*last[A-Za-z]*\s*\)\s*return\s*false\s*;/.test(half),
    "半迁移的合成样本没造出旧形状，半迁移检查就量不到东西",
  );
});

test("守卫覆盖的范围没有悄悄变小", () => {
  const files = sources();
  assert.ok(files.length >= 3, `只扫到 ${files.length} 个文件，路径可能不对`);
  assert.ok(
    files.some((f) => relative(API_ROOT, f).endsWith("run-processing-tick.ts")),
    "扫描范围里没有 run-processing-tick.ts",
  );
});

