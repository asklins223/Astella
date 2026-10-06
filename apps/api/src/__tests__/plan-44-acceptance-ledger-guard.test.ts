import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 方案 44 §8：验收清单的**逐条归属**。
 *
 * ## 为什么需要这条守卫
 *
 * §8 是一张 21 条的清单，写成 `- [ ]` 之后它看起来像「待办」。实际状态却有三种：
 *   1. **代码侧已经能验的**——有具体测试，只是清单里没写出来；
 *   2. **需要环境才能验的**——真实模型样本、实库并发/恢复、窗口观察；
 *   3. **两边都不属于的**（写错了、或被后续决定取代）——那种应该被改掉。
 * 三种混在同一个 `[ ]` 里，读的人分不出「还欠什么」和「已经有什么」。文档状态词
 * 与旧「已完成」声明都不能证明实现（AGENTS.md），所以判据要能自己跑。
 *
 * ## 判据
 *
 * 每条清单项后面必须带一个**归属标记**：
 *   - ``证据：`用例名` `` —— 反引号里的每个名字都必须真的是仓库里某个用例的标题；
 *   - `待环境：<命令>` —— 必须给出**可执行**的命令，不是「以后再看」；
 *   - `待窗口：<场景>` —— 只能靠真实窗口观察的项（交互链路、前后台切换、成长界面）。
 *     它没有命令可跑，所以要求写出**具体场景**；写成「需要人工验证」不算。
 *
 * 用反引号而不是文件路径：清单要读得下去，而**用例名是唯一的**——它同时回答了
 * 「验的是哪一条」与「在哪个测试里」，比路径更能防止清单随时间漂走。
 *
 * 这条守卫只证明「每一项都被认领过」，**不证明效果**：测试通过不等于体验好，
 * 环境项在跑之前也仍然是空的。
 */

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/+$/, "");
const PLAN = join(REPO_ROOT, "docs/plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md");

/** 收集仓库里的测试文件内容，用来核对 `证据：` 指向的用例名真的存在。 */
function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let isDirectory: boolean;
      try { isDirectory = statSync(path).isDirectory(); } catch { continue; }
      if (isDirectory) {
        if (name === "node_modules" || name === "dist" || name === ".git") continue;
        walk(path);
        continue;
      }
      if (!/\.(test|integration)\.(ts|tsx)$/.test(name)) continue;
      try { out.push(readFileSync(path, "utf8")); } catch { /* 读不到就跳过 */ }
    }
  };
  for (const rel of ["apps/api/src", "packages", "workers/ai-worker/src"]) {
    if (existsSync(join(REPO_ROOT, rel))) walk(join(REPO_ROOT, rel));
  }
  return out;
}

interface ChecklistItem { line: number; text: string }

function checklistItems(): ChecklistItem[] {
  const lines = readFileSync(PLAN, "utf8").split("\n");
  const items: ChecklistItem[] = [];
  let inSection = false;
  lines.forEach((text, index) => {
    if (/^## 8\./.test(text)) inSection = true;
    else if (/^## 9\./.test(text)) inSection = false;
    if (inSection && text.startsWith("- [ ] ")) items.push({ line: index + 1, text });
  });
  return items;
}

test("方案 44 §8 的每一条清单项都认领了归属（证据／待环境／待窗口）", () => {
  const items = checklistItems();
  assert.ok(items.length >= 15, `只读到 ${items.length} 条清单项，解析器可能坏了`);
  const unclaimed = items
    .filter(item => !item.text.includes("证据：")
      && !item.text.includes("待环境：") && !item.text.includes("待窗口："))
    .map(item => `第 ${item.line} 行：${item.text.slice(6, 60)}…`);
  assert.deepEqual(unclaimed, [],
    "这些清单项既没写证据也没写待环境，读的人分不出「还欠什么」与「已经有什么」：\n  "
    + unclaimed.join("\n  "));
});

test("方案 44 §8 里写着「证据」的清单项，指向的用例真的存在", () => {
  const sources = testSources();
  const missing: string[] = [];
  for (const item of checklistItems()) {
    // 一段证据从 `证据` 或 `证据（…）` 起，到 `待环境：` 或行尾止；
    // 其中反引号包住的就是用例名（其余是解释文字，不参与核对）。
    const evidence = item.text.match(/证据(?:（[^）]*）)?：([\s\S]*?)(?=待环境：|$)/)?.[1] ?? null;
    if (evidence === null) continue;
    const claims = [...evidence.matchAll(/`([^`]+)`/g)].map(match => match[1]!.trim());
    if (claims.length === 0) { missing.push(`第 ${item.line} 行：证据里没有反引号包住的用例名`); continue; }
    for (const testName of claims) {
      if (!sources.some(source => source.includes(testName))) {
        missing.push(`第 ${item.line} 行：找不到用例「${testName}」`);
      }
    }
  }
  assert.deepEqual(missing, [], "这些「证据」指向了不存在的用例（清单在说谎）：\n  " + missing.join("\n  "));
});

test("方案 44 §8 里写着「待环境」的清单项，给了可执行的命令", () => {
  const missing: string[] = [];
  for (const item of checklistItems()) {
    const claim = item.text.match(/待环境：([\s\S]*)$/)?.[1]?.trim();
    if (!claim) continue;
    // 命令必须可执行：带 npm run / make / node / npx 这类真实入口。
    if (!/(npm (run )?|make |node |npx )/.test(claim)) {
      missing.push(`第 ${item.line} 行：「${claim}」不是一条能跑的命令`);
    }
  }
  assert.deepEqual(missing, [], "这些「待环境」项没有给出可执行命令：\n  " + missing.join("\n  "));
});

test("方案 44 §8 里写着「待窗口」的清单项，写出了具体场景而不是「人工验证」", () => {
  const missing: string[] = [];
  for (const item of checklistItems()) {
    const claim = item.text.match(/待窗口：([\s\S]*)$/)?.[1]?.trim();
    if (!claim) continue;
    // 空话不算场景：必须说清在窗口里做什么、看什么。
    if (claim.length < 12 || /^(需要)?(人工|手动)?(验证|观察|确认)[。.]?$/.test(claim)) {
      missing.push(`第 ${item.line} 行：「${claim}」没说清在窗口里看什么`);
    }
  }
  assert.deepEqual(missing, [], "这些「待窗口」项写得看不出要做什么：\n  " + missing.join("\n  "));
});

test("判据不是空跑：清单里既有已认领的证据，也有待环境的项", () => {
  const items = checklistItems();
  const withEvidence = items.filter(item => item.text.includes("证据："));
  const withEnvironment = items.filter(item => item.text.includes("待环境："));
  assert.ok(withEvidence.length > 0, "一条「证据」都没有——那就还是一张纯粹的待办");
  assert.ok(withEnvironment.length > 0, "一条「待环境」都没有——真实模型与实库那些项去哪了");
  assert.ok(items.some(item => item.text.includes("待窗口：")), "窗口验证那几条也该被认领");
});
