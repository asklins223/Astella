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
const traceModule = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-compaction-trace.ts", import.meta.url),
  "utf8",
);

test("44 §5.3：快照推进到下一版是有围栏的，迟到结果不许覆盖", () => {
  // run 仍在进行中，且版本号正好是这一行当前的那一版。
  assert.match(dialogueStore, /r\.status IN \('accepted', 'running', 'waiting_for_confirmation'\)/);
  assert.match(dialogueStore, /astella_assert_handoff_snapshot_fence/);
  assert.match(migration, /p_expected_version integer/);
  assert.match(migration, /s\.snapshot_version = p_expected_version/);
  assert.match(dialogueStore, /snapshot_version = s\.snapshot_version \+ 1/);
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
  // 写新版本时只加轨迹，不替换 modelMessages。
  assert.match(dialogueStore, /const next: CompanionContextHandoffSnapshotV1 = \{\s*\n?\s*\.\.\.args\.snapshot,/);
  assert.match(dialogueStore, /compactions: \[\.\.\.\(args\.snapshot\.compactions \?\? \[\]\), \.\.\.args\.compactions\]/);
  assert.ok(!/modelMessages: \[\]/.test(dialogueStore), "不能把折叠后的空回放写回快照");
});

test("44 §5.4：轨迹没写成不是交付失败——回复照常收尾", () => {
  assert.match(traceModule, /catch \(error\)/);
  assert.match(traceModule, /return false/);
  assert.match(traceModule, /failed to record compaction trace on handoff snapshot/);
  // 围栏没过时也只是跳过，不抛。
  assert.match(dialogueStore, /handoff snapshot compaction trace skipped: run ended or snapshot already advanced/);
});

test("44 §3.3：loop 里折了就记，轨迹真的从 runtime 流到快照", () => {
  assert.match(runtime, /compactionTrace\?\.record\(/);
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
