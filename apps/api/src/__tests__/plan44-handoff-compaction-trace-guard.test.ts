import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 方案 44 §3.3／§5.3：把这一轮折过什么记进交接快照，并且**带围栏**。
 *
 * 背景：交接快照的注释写的是「exact context handed to one dialogue run」，而它在 agent
 * loop **之前**就提交了。压缩发生在 loop 里——没有这份轨迹，那句话在有压缩的那一轮
 * 是假的：从快照上看不出哪一段被折、哪份摘要顶替、那次判定是过了线还是被拒绝。
 */

const migration = readFileSync(
  new URL("../db/migrations/0389_handoff_snapshot_compaction_trace.sql", import.meta.url),
  "utf8",
);
// 2026-10-15：推进路径改为 0438 的追加函数（worker 无 UPDATE 权限，围栏在函数内）。
// 旧围栏函数 0389 仍保留给既有集测；本轮断言跟到新的落点。
const appendMigration = readFileSync(
  new URL("../db/migrations/0438_handoff_compaction_append.sql", import.meta.url),
  "utf8",
);
const dialogueStore = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-dialogue-store.ts", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts", import.meta.url),
  "utf8",
);
const dialogue = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-dialogue.ts", import.meta.url),
  "utf8",
);
const stepCompaction = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-step-compaction.ts", import.meta.url),
  "utf8",
);
const traceModule = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-compaction-trace.ts", import.meta.url),
  "utf8",
);

test("44 §5.3：快照推进到下一版是有围栏的，迟到结果不许覆盖", () => {
  // 围栏落点在 0438 的追加函数：run 仍在进行中、快照按读到的那一版锁住、
  // 旧前缀不许被替换、版本只在函数内 +1；worker 不再直接 UPDATE 快照行。
  assert.match(appendMigration, /status IN \('accepted','running','waiting_for_confirmation'\)/);
  assert.match(appendMigration, /snapshot_sha256=p_expected_sha FOR UPDATE OF s/);
  assert.match(appendMigration, /jsonb_array_length\(p_compactions\) <= jsonb_array_length\(v_previous\)/);
  assert.match(appendMigration, /snapshot_version=snapshot_version\+1/);
  // worker 侧读到的快照要带 run 状态围栏，推进只能经由这个函数。
  assert.match(dialogueStore, /r\.status IN \('accepted', 'running', 'waiting_for_confirmation'\)/);
  assert.match(dialogueStore, /astella_append_handoff_compactions_v1/);
  // 0389 的旧围栏函数仍留给既有集测，形状不回归。
  assert.match(migration, /p_expected_version integer/);
  assert.match(migration, /s\.snapshot_version = p_expected_version/);
});

test("44 §3.3：折叠只记区间与水位，不记正文", () => {
  // 轨迹里没有任何正文字段——只记范围、顶替它的摘要哈希与那一轮的判定。
  const trace = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-context-handoff.ts", import.meta.url),
    "utf8",
  );
  // 只取这个 interface 本身：切片到它的收尾为止，别把后面的接口也扫进来。
  const start = trace.indexOf("export interface CompactionTraceV1");
  const shape = trace.slice(start, trace.indexOf("\n}", start) + 2);
  for (const forbidden of ["content", "text", "body", "messages"]) {
    assert.ok(!new RegExp(`\\n  ${forbidden}[?]?:`).test(shape),
      `CompactionTraceV1 不该带 ${forbidden} —— 那会把正文再抄一遍`);
  }
  assert.match(shape, /summarySourceSha256: string/);
  assert.match(shape, /hardInputTokens: number \| null/);
});

test("44 §5.4：`modelMessages` 保持折叠前的内容——恢复时多给上下文更安全", () => {
  const trace = readFileSync(
    new URL("../../../../workers/ai-worker/src/handlers/companion-context-handoff.ts", import.meta.url),
    "utf8",
  );
  const snapshotAt = trace.indexOf("export interface CompanionContextHandoffSnapshotV1");
  const shape = trace.slice(snapshotAt, trace.indexOf("\n}", snapshotAt) + 2);
  assert.match(shape, /modelMessages: ChatMessage\[\]/);
  // 写新版本时只加轨迹：JS 先要求底座（除 compactions 外）与提交时一致，
  // SQL 也只 jsonb_set 这一格——modelMessages 保持折叠前的完整上下文。
  assert.match(dialogueStore, /base\(current\.snapshot\) !== base\(args\.snapshot\)/);
  assert.match(dialogueStore, /const compactions = \[\.\.\.existing, \.\.\.added\]/);
  assert.match(appendMigration, /jsonb_set\(v_snapshot,'\{compactions\}',p_compactions,true\)/);
  assert.ok(!/modelMessages: \[\]/.test(dialogueStore), "不能把折叠后的空回放写回快照");
});

test("44 §5.4：轨迹没写成不是交付失败——回复照常收尾", () => {
  assert.match(traceModule, /catch \(error\)/);
  assert.match(traceModule, /return false/);
  assert.match(traceModule, /failed to record compaction trace on handoff snapshot/);
  // 围栏没过时也只是跳过（返回 false 收尾），重试只为「别人刚追加过」这一种情况空转。
  assert.match(dialogueStore, /if \(!current \|\| current\.snapshot_sha256 === lastRejectedHash/);
  assert.match(dialogueStore, /lastRejectedHash = current\.snapshot_sha256/);
});

test("44 §3.3：loop 里折了就记，轨迹真的从 runtime 流到快照", () => {
  // 2026-10-16（神文件棘轮）：发出口随压力压缩搬到 companion-step-compaction.ts，
  // 记账那一句跟着走；运行时仍负责把 recorder 交给工厂，两处各钉一半。
  assert.match(stepCompaction, /compactionTrace\?\.record\(/);
  assert.match(runtime, /compactionTrace: args\.compactionTrace,/);
  assert.match(dialogue, /await compactionTrace\.commit\(/);
  assert.match(dialogue, /const compactionTrace = createCompactionTraceRecorder\(\)/);
});

test("44 §3.3：没有发生过折叠就不写新版本", () => {
  assert.match(traceModule, /if \(args\.traces\.length === 0\) return false/);
});

test("44 §5.4：提交点必须紧跟 loop——waiting_for_confirmation 分支会提前 return", () => {
  const at = dialogue.indexOf("await compactionTrace.commit(");
  const atBranch = dialogue.indexOf('if (agentResult.status === "waiting_for_confirmation")');
  assert.ok(at > 0 && atBranch > 0);
  // 围栏允许 waiting_for_confirmation 时写，而那个分支自己会 return——
  // 提交点排在分支之后，提议确认那一步折掉的内容就永远进不了审计。
  assert.ok(at < atBranch, "提交点必须在任何分支之前");
});
