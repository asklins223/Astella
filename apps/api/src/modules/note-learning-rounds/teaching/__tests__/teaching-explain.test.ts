/**
 * 教学产物：解释生成的确定性半边（39d W4-6 刀一）。
 *
 * 这一份是**单元**用例，不碰库：确定性 provider 的选节/取材规则、失败分档的对外形状、
 * 以及内核外壳在这条链上的两条纪律（可重试的才重试；`invalid_input` 一次就停）。
 * 落库与权限那半边在 `note-learning-round-teaching-postgres.integration.ts`（双口径）。
 */
import { test } from "node:test";

// 每一次外发的真实身份：provider 的治理出口按它建，缺了就抛错。
const scope = { workspaceId: "00000000-0000-0000-0000-000000000001", userId: "00000000-0000-0000-0000-000000000002" };
import assert from "node:assert/strict";
import {
  NOTE_TEACHING_EXPLAIN_TASK_ID,
  NOTE_TEACHING_EXPLAIN_TASK_VERSION,
  buildDeterministicTeachingV1,
  createNoteTeachingExplainTaskV1,
  deterministicTeachingExplainProviderV1,
  isTeachingExampleV1,
  plainTextOfBlockV1,
  runTeachingExplainV1,
  teachingFailureResponseV1,
  type TeachingExplainInputV1,
  type TeachingExplainOutputV1,
  type TeachingExplainProviderV1,
} from "../teaching-explain.ts";
import type { AiStepResult } from "@astella/shared/ai-task-kernel";

const blocks = [
  { ordinal: 1, type: "heading", text: "## 间隔重复" },
  { ordinal: 2, type: "paragraph", text: "**间隔重复**说的是在快要忘记的时候再见到它。" },
  { ordinal: 3, type: "paragraph", text: "例如把新词放在第 1、3、7 天各见一次。" },
  { ordinal: 4, type: "heading", text: "## 提取练习" },
  { ordinal: 5, type: "paragraph", text: "提取练习是**先想再查**：先自己试着说出来。" },
  { ordinal: 6, type: "paragraph", text: "比如合上书,把这一节讲给空气听一遍。" },
];

function input(overrides: Partial<TeachingExplainInputV1> = {}): TeachingExplainInputV1 {
  return {
    drivingQuestion: "先弄懂「提取练习」这一节在讲什么",
    planSteps: ["先看小节标题", "再读第一段"],
    blocks,
    ...overrides,
  };
}

test("plainTextOfBlockV1：把最小一层标记剥掉（标题号、加粗、链接、行内码）", () => {
  assert.equal(plainTextOfBlockV1("## 间隔重复"), "间隔重复");
  assert.equal(plainTextOfBlockV1("**间隔重复**说的是"), "间隔重复说的是");
  assert.equal(plainTextOfBlockV1("看[这一篇](https://example.com/a)的第三段"), "看这一篇的第三段");
  assert.equal(plainTextOfBlockV1("`code` 与 __重点__"), "code 与 重点");
  assert.equal(plainTextOfBlockV1("![图](/api/uploads/x.png)文字在后面"), "文字在后面");
  assert.equal(plainTextOfBlockV1("   \n  "), "");
});

test("isTeachingExampleV1：例子块靠材料里本来就有的提示词认，不靠猜", () => {
  assert.equal(isTeachingExampleV1("例如把新词放在第 1、3、7 天各见一次。"), true);
  assert.equal(isTeachingExampleV1("比如合上书，把这一节讲给空气听一遍。"), true);
  assert.equal(isTeachingExampleV1("提取练习是先想再查。"), false);
});

test("确定性解释：问句点名的那一节被选中，正文与依据都从那一段取", () => {
  const derived = buildDeterministicTeachingV1(input());
  assert.ok(derived);
  assert.equal(derived.explanation, "「提取练习」这一节说的是：提取练习是先想再查：先自己试着说出来。");
  // 例子取的是同一节里带"比如"的那一块；依据按块序去重排序。
  assert.equal(derived.example, "比如合上书,把这一节讲给空气听一遍。");
  assert.deepEqual(derived.sourceBlockOrdinals, [4, 5, 6]);
});

test("确定性解释：问句没点名任何一节时取第一小节；全篇无小节时从第一块可读正文起", () => {
  const first = buildDeterministicTeachingV1(input({ drivingQuestion: "这一篇在说什么" }));
  assert.ok(first);
  assert.match(first.explanation, /^「间隔重复」这一节说的是：/);
  assert.deepEqual(first.sourceBlockOrdinals, [1, 2, 3]);

  const noHeadings = buildDeterministicTeachingV1(input({
    drivingQuestion: "这一篇在说什么",
    blocks: blocks.filter((block) => block.type !== "heading").slice(0, 1),
  }));
  assert.ok(noHeadings);
  assert.equal(noHeadings.explanation, "间隔重复说的是在快要忘记的时候再见到它。");
  assert.deepEqual(noHeadings.sourceBlockOrdinals, [2]);
});

test("确定性解释：材料里没有可读正文时返回 null（不编一句盖过去）", () => {
  assert.equal(buildDeterministicTeachingV1(input({ blocks: [] })), null);
  assert.equal(
    buildDeterministicTeachingV1(input({ blocks: [{ ordinal: 1, type: "paragraph", text: "   " }] })),
    null,
  );
});

test("确定性 provider：拼不出来时是 invalid_input（不可重试那一类）", async () => {
  const provider = deterministicTeachingExplainProviderV1();
  const ok = await provider(input(), { signal: new AbortController().signal, scope });
  assert.equal(ok.ok, true);
  const empty = await provider(input({ blocks: [] }), { signal: new AbortController().signal, scope });
  assert.equal(empty.ok, false);
  assert.equal((empty as { class: string }).class, "invalid_input");
});

test("失败分档：材料里没有可讲的 vs provider 那边没成，是两类话", () => {
  assert.deepEqual(teachingFailureResponseV1({ class: "invalid_input", message: "x" }), {
    status: 409,
    error: "teaching_material_missing",
    message: "这一篇现在没有可以用来解释的正文",
  });
  const transient = teachingFailureResponseV1({ class: "timeout", message: "x" });
  assert.equal(transient.status, 503);
  assert.equal(transient.error, "teaching_failed");
});

test("任务定义：身份与预算形状（换 provider 不该动这些）", async () => {
  const task = createNoteTeachingExplainTaskV1({
    provider: deterministicTeachingExplainProviderV1(),
    input: input(),
    scope,
  });
  assert.equal(task.id, NOTE_TEACHING_EXPLAIN_TASK_ID);
  assert.equal(task.version, NOTE_TEACHING_EXPLAIN_TASK_VERSION);
  assert.equal(task.mode, "structured");
  assert.equal(task.resourceClass, "interactive_ai");
  assert.deepEqual(task.completion, { kind: "structured_parsed" });
  // `prepare` 交出的就是冻结好的那一份输入（不在这里读库）。
  const prepared = await task.prepare(
    { workspaceId: "w", userId: "u", inputSnapshotRef: { kind: "note_version", id: "n", hash: "h" }, permissionLevel: "server" },
    { taskId: task.id, taskVersion: 1, attemptId: "a", leaseToken: "l", idempotencyKey: "k", workspaceId: "w", userId: "u" },
  );
  assert.deepEqual(prepared, input());
});

async function runWithProvider(provider: TeachingExplainProviderV1, ordinal = 1) {
  return runTeachingExplainV1({
    provider,
    input: input(),
    scope: { workspaceId: "00000000-0000-0000-0000-0000000000aa", userId: "00000000-0000-0000-0000-0000000000bb" },
    round: {
      roundId: "00000000-0000-0000-0000-0000000000cc",
      noteVersionId: "00000000-0000-0000-0000-0000000000dd",
      sourceContentHash: "0123456789abcdef0123456789abcdef",
    },
    ordinal,
    currentActiveTransaction: () => undefined,
  });
}

test("内核外壳：可重试的失败按 maxAutoRetries 重试一次，第二次才判失败", async () => {
  let calls = 0;
  const flaky: TeachingExplainProviderV1 = async () => {
    calls += 1;
    return { ok: false, class: "output_shape", message: "形状不对" };
  };
  const result = await runWithProvider(flaky);
  assert.equal(result.ok, false);
  assert.equal((result as { class: string }).class, "output_shape");
  // 首次 + 1 次自动重试（预算里的 maxAutoRetries=1）——这条链真跑两次。
  assert.equal(calls, 2);
  // **引用常量而不是写死字面量**：这两条曾经写死 `@v1`，而实现把 NOTE_TEACHING_EXPLAIN_TASK_VERSION 提到 2 之后它们一直红着——「实现改了、用例没跟上」的典型形状。写死字面量等于把下一次版本提升也变成一次红。
  // 失败那一发的前缀匹配不是宽松，是**它本来就多一个 `:failed` 后缀**：成功那一条是精确相等，
  // 失败这一条是「同一个 id@版本，后面缀着失败态」。两条原本一个用 match 一个用 equal，
  // 这里保留这个差别而不是统一成一种——把它们写成同一种断言，等于丢掉「失败态有后缀」这条信息。
  assert.ok(
    result.attemptRef.startsWith(`${NOTE_TEACHING_EXPLAIN_TASK_ID}@v${NOTE_TEACHING_EXPLAIN_TASK_VERSION}:`),
    `失败那一次的 attemptRef 应以 id@版本: 开头并缀着失败态，实际是 ${result.attemptRef}`,
  );
});

test("内核外壳：invalid_input 不重试（材料问题重试一百次也一样）", async () => {
  let calls = 0;
  const provider: TeachingExplainProviderV1 = async () => {
    calls += 1;
    return { ok: false, class: "invalid_input", message: "没有可讲的材料" };
  };
  const result = await runWithProvider(provider);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("内核外壳：成功那一发带回执引用，输出原样交给调用方", async () => {
  const provider: TeachingExplainProviderV1 = async () => ({
    ok: true,
    output: { explanation: "解释", sourceBlockOrdinals: [1] } satisfies TeachingExplainOutputV1,
  });
  const result = await runWithProvider(provider, 3);
  assert.equal(result.ok, true);
  assert.equal(result.attemptRef, `${NOTE_TEACHING_EXPLAIN_TASK_ID}@v${NOTE_TEACHING_EXPLAIN_TASK_VERSION}`);
  assert.deepEqual((result as { output: TeachingExplainOutputV1 }).output.sourceBlockOrdinals, [1]);
});

test("内核外壳：provider 抛异常被归成 transport（可重试那一类），两次都抛才失败", async () => {
  let calls = 0;
  const throwing: TeachingExplainProviderV1 = async () => {
    calls += 1;
    throw new Error("socket hang up");
  };
  const result = await runWithProvider(throwing);
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
});

/** 类型上的正控制：`AiStepResult` 的两支都能喂进 provider（少一支编译就不过）。 */
const _typeControl: AiStepResult<TeachingExplainOutputV1> = {
  ok: false,
  class: "transport",
  message: "x",
};
void _typeControl;

test("本链也在 W3-2 那道闸门内：作用域里有活动事务时拒绝，不静默跑", async () => {
  let calls = 0;
  const provider: TeachingExplainProviderV1 = async () => {
    calls += 1;
    return { ok: true, output: { explanation: "解释", sourceBlockOrdinals: [] } };
  };
  await assert.rejects(
    runTeachingExplainV1({
      provider,
      input: input(),
      scope: { workspaceId: "00000000-0000-0000-0000-0000000000aa", userId: "00000000-0000-0000-0000-0000000000bb" },
      round: {
        roundId: "00000000-0000-0000-0000-0000000000cc",
        noteVersionId: "00000000-0000-0000-0000-0000000000dd",
        sourceContentHash: "0123456789abcdef0123456789abcdef",
      },
      ordinal: 1,
      // 「有活动事务」这一档：闸门必须当场拒（持锁等模型＝把并发读写一起钉住）。
      currentActiveTransaction: () => ({ scope: "fake" }),
    }),
    /外部调用被拒/,
  );
  assert.equal(calls, 0, "被拒的这一次连 provider 都不该进");
});
