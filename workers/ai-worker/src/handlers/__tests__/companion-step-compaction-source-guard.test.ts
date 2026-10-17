/**
 * 压力压缩发出口的接线守卫（2026-10-16：神文件棘轮把这一段从
 * `companion-agent-runtime.ts` 搬进 `companion-step-compaction.ts`）。
 *
 * 行为面已经由 `companion-agent-runtime.test.ts`（桩 provider）与
 * `companion-dialogue-postgres` 集测在真链上跑到；这份守的是**搬出之后容易接错**的四件事：
 *  1. 可变状态仍归运行时——模块里不许自己给 `messages` / `historyFoldApplied` 赋值；
 *  2. 中断（取消／租约失效／上下文变更）必须往上抛，不能当成"折不动"咽下去；
 *  3. 检查点命中与额度消耗的顺序保持在重发之前；
 *  4. 运行时用工厂的 setter 交接 stepId 与 provider，而不是继续拿着旧副本。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const moduleSource = readFileSync(join(import.meta.dirname, "../context/companion-step-compaction.ts"), "utf8");
const runtimeSource = readFileSync(join(import.meta.dirname, "../agent/companion-agent-runtime.ts"), "utf8");

test("发出口只通过访问器读写运行时持有的 messages 与折叠标记", () => {
  assert.match(moduleSource, /if \(folded\) deps\.setMessages\(\[\.\.\.folded\.messages\]\);/);
  assert.match(moduleSource, /deps\.getHistoryFoldApplied\(\)/);
  assert.doesNotMatch(moduleSource, /^\s*(?:messages|historyFoldApplied) = /m,
    "模块自己拿走了 messages 的所有权——运行时后面的步骤会读到旧的那份");
});

test("取消、租约失效与上下文变更照旧往上抛，不当成折不动", () => {
  const rethrows = moduleSource.match(
    /if \(deps\.signal\.aborted \|\| error instanceof JobLeaseLostError \|\| error instanceof CompanionContextChangedError\) throw error;/g) ?? [];
  assert.equal(rethrows.length, 2,
    `历史与工具上下文两条折叠路径都要让中断上抛（当前只有 ${rethrows.length} 处）`);
});

test("命中检查点时不再折第二次，额度在每次重发之前消耗", () => {
  assert.match(moduleSource, /restore: \(\) => \{[\s\S]{0,200}restoreCompactionCheckpoint\(\{/);
  assert.match(moduleSource, /consumeAttempt: \(\) => deps\.contextReceipts\?\.consumeCompactionAttempt\(\)/);
  assert.match(moduleSource, /restored complete compaction checkpoint for identical request/);
});

test("运行时把 stepId 与 provider 交给 setter，回执仍按原顺序记", () => {
  assert.match(runtimeSource, /stepCompaction\.setStepId\(stepId\);/);
  assert.match(runtimeSource, /stepCompaction\.setProvider\(stepProvider\);/);
  assert.match(moduleSource, /checkpoint: createCompactionCheckpoint\(deps\.read, compactionRequest, foldedMessages, source\)/);
  assert.match(moduleSource, /await deps\.persistCompactionTraces\?\.\(\);/);
});
