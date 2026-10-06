import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 方案 44 §4.3：调用前压力闸必须覆盖**所有**实际模型调用面。
 *
 * 压力闸接在 `createGovernedProvider` 上——那是外发模型的唯一边界。正因为是唯一
 * 边界，它才「天然覆盖」；也正因为是天然覆盖，一旦哪天有人为了图省事直接拿
 * `createProvider(...)` 的裸实例去发一次模型调用，整条治理（同意、政策、PII、
 * 审计、**预算**）连同闸一起被绕过，而且没有任何测试会红。
 *
 * 判据只查一件结构事实：**生产代码里出现 `createProvider(` 的文件，必须同时出现
 * `createGovernedProvider(`**。裸 provider 只能活在治理包装器内部，或者测试与
 * 探针脚本里。
 *
 * 为什么不做更细的语法分析：闸在包装器里，包装关系是运行期的。这里能查的只有
 * 「这个文件是不是在造裸 provider」——那正是绕过发生的那一步。
 */

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/+$/, "");
const ROOTS = ["workers/ai-worker/src", "apps/api/src", "apps/desktop-client/src"];
/**
 * 治理包装器自己就是「造裸 provider」的那一处：它的职责是把裸的变成受管的。
 */
const ALLOWED = new Set([
  "workers/ai-worker/src/lib/governance.ts",
  "workers/ai-worker/src/card-generation-v2/governed-provider.ts",
  "workers/ai-worker/src/lib/ai-provider.ts",
]);

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(name)) continue;
      // `integration-tests/` 与 `scripts/` 整棵树都是离线评测/实库夹具/人工探针：
      // 它们在宿主上按仓库 .env 跑，本来就没有工作区与 actor 可供治理，也不属于
      // 用户请求的调用面。按目录排除，而不是把 eval-provider 之类逐个列进豁免。
      if (/[\\/](integration-tests|scripts)[\\/]/.test(p)) continue;
      // 测试与集成测试不是产品调用面。
      if (/\.(test|integration|bench|spec)\.(ts|tsx)$/.test(name)) continue;
      out.push(p);
    }
  };
  for (const rel of ROOTS) {
    const abs = join(REPO_ROOT, rel);
    try { walk(abs); } catch { /* 目录不存在时跳过，而不是让判据空跑 */ }
  }
  return out;
}

test("治理边界存在，且它就是压力闸所在的包装器", () => {
  const governance = readFileSync(join(REPO_ROOT, "workers/ai-worker/src/lib/governance.ts"), "utf8");
  assert.match(governance, /export function createGovernedProvider\(/);
  // 闸必须真的在包装器里，且三条模型方法都过了闸——少一条就是一个没被治理的面。
  assert.match(governance, /governContextPressure\(/);
  assert.match(governance, /chatCompletion:/);
  assert.match(governance, /chatCompletionStream =/);
  assert.match(governance, /executeAgentTurn =/);
});

test("44 §4.3：生产代码里没有绕过治理包装器的裸 provider 调用面", () => {
  const offenders: string[] = [];
  for (const file of productionFiles()) {
    const rel = file.replace(`${REPO_ROOT}/`, "");
    if (ALLOWED.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    // 只认真的在造 provider：注释与类型引用不算。
    const creates = /(?<![\w.])createProvider\s*\(/.test(source.replace(/^\s*\*.*$/gm, ""));
    if (!creates) continue;
    if (!/createGovernedProvider\s*\(/.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "这些文件直接造了裸 provider 却没有经过 createGovernedProvider —— "
    + "同意、政策、PII、审计与上下文预算闸会一起被绕过：\n  " + offenders.join("\n  "));
});

test("判据不是空跑（造裸 provider 的文件确实被扫到）", () => {
  let scanned = 0;
  for (const file of productionFiles()) {
    if (/createProvider\s*\(/.test(readFileSync(file, "utf8"))) scanned += 1;
  }
  assert.ok(scanned >= 6, `只扫到 ${scanned} 个造 provider 的文件，收集器可能坏了`);
});
