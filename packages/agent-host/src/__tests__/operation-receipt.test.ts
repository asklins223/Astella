/**
 * 回执消费函数的分派与状态映射（无数据库）。
 *
 * 假执行器把真实 SQL 记录下来并回放固定行，于是"查询写对了吗"和"这一行该怎么落"两件事
 * 都能在单测里钉住——card 那一支的两个真实缺陷（多列被包成标量子查询、漏掉审核开放那一格）
 * 正是类型检查与纯 reducer 都看不见的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SQL } from "drizzle-orm";

import { readOperationResultReceipt } from "../operation-receipt.ts";
import type { AgentSqlExecutor } from "../store.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CARD_RUN = "99999999-9999-4999-8999-999999999999";
const OTHER_CARD_RUN = "99999999-9999-4999-8999-999999999998";
const JOB = "66666666-6666-4666-8666-666666666666";
const NOTE = "77777777-7777-4777-8777-777777777777";
const NOTE_VERSION = "88888888-8888-4888-8888-888888888888";

const SCOPE = { workspaceId: WORKSPACE, userId: USER };
const INPUTS = [{ kind: "note_version" as const, noteId: NOTE, noteVersionId: NOTE_VERSION }];

interface CardRow {
  id: string; noteId: string; noteVersionId: string; status: string; reviewableCandidate: boolean;
}

/**
 * 取 SQL 的静态文本：只展开字符串块与嵌套 SQL，参数块跳过——断言关心的都是结构
 * （子查询层级、合取条件、领域事件类型名），不是绑定值。
 */
function sqlText(node: unknown): string {
  // 注意：map 会把下标当第二个实参传进来，必须显式包一层。
  if (Array.isArray(node)) return node.map(chunk => sqlText(chunk)).join("");
  if (node === null || typeof node !== "object") return "";
  const nested = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(nested)) return sqlText(nested);
  if ((node as object).constructor.name !== "StringChunk") return "";
  const value = (node as { value?: unknown }).value;
  // 这一版 drizzle 的 StringChunk.value 是字符串数组。
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter(part => typeof part === "string").join("") : "";
}

/** 记录每次查询的 SQL 文本，按调用次序回放固定行。 */
function fakeTx(rows: unknown[][]) {
  const texts: string[] = [];
  const executor: AgentSqlExecutor = {
    async execute(query: SQL): Promise<unknown> {
      texts.push(sqlText(query.queryChunks));
      return rows[texts.length - 1] ?? [];
    },
  };
  return { executor, texts };
}

function cardRequest(overrides: Partial<Parameters<typeof readOperationResultReceipt>[1]> = {}) {
  return {
    capability: "card_generation_generate",
    execution: { kind: "card_generation" as const, id: CARD_RUN },
    scope: SCOPE, inputs: INPUTS, ...overrides,
  };
}

const delivered: CardRow = {
  id: CARD_RUN, noteId: NOTE, noteVersionId: NOTE_VERSION,
  status: "review_ready", reviewableCandidate: true,
};

test("card 查询直接读多列行，不包成标量子查询", async () => {
  const { executor, texts } = fakeTx([[delivered]]);
  const receipt = await readOperationResultReceipt(executor, cardRequest());
  assert.deepEqual(receipt, { kind: "result", result: { kind: "artifact",
    artifact: { kind: "card_candidates", id: CARD_RUN, noteId: NOTE, noteVersionId: NOTE_VERSION } } });
  assert.equal(texts.length, 1);
  assert.equal(/SELECT \(\s*SELECT/i.test(texts[0]!), false, "多列结果不能包成标量子查询");
});

test("审核开放那一格写在查询里：cancelled / activated 上的 passed 行不可交付", async () => {
  const { executor, texts } = fakeTx([[delivered]]);
  await readOperationResultReceipt(executor, cardRequest());
  assert.match(texts[0]!, /r\.status IN \('review_ready','needs_attention'\)/);
  // 只查候选不够：cancelled 上留着的 passed 行满足其余全部条件。
  const notReviewOpen = /\(r\.status IN \('review_ready','needs_attention'\) AND EXISTS/.test(texts[0]!);
  assert.equal(notReviewOpen, true, "审核开放必须与候选 EXISTS 合取");

  for (const status of ["cancelled", "activated", "closed_without_activation", "failed", "stale"]) {
    const replay = fakeTx([[{ ...delivered, status, reviewableCandidate: false }]]);
    assert.deepEqual(
      (await readOperationResultReceipt(replay.executor, cardRequest())).kind, "failed",
      `${status} 已定终局却没有可交付成果`,
    );
  }
  // 仍在生成的那些档位是 pending（交给调用方落 accepted/running），不是 failed。
  for (const status of ["queued", "planning", "authoring", "checking"]) {
    const replay = fakeTx([[{ ...delivered, status, reviewableCandidate: false }]]);
    assert.deepEqual(
      (await readOperationResultReceipt(replay.executor, cardRequest())).kind, "pending",
      `${status} 还在生成，不该被判失败`,
    );
  }
});

test("review_ready 却查不到带证据的可审候选：pending（终局事件落 outcome_unknown），不是 failed", async () => {
  // 领域说候选可审，而交付证据仍然缺——把「核对不到」宣称为确定失败是拿不确定当事实。
  const noCandidate = fakeTx([[{ ...delivered, status: "review_ready", reviewableCandidate: false }]]);
  assert.deepEqual((await readOperationResultReceipt(noCandidate.executor, cardRequest())).kind, "pending");

  // 同一档一旦真的查到带证据的可审候选，仍然正常交付。
  const withCandidate = fakeTx([[delivered]]);
  const receipt = await readOperationResultReceipt(withCandidate.executor, cardRequest());
  assert.equal(receipt.kind, "result");
  if (receipt.kind === "result" && receipt.result.kind === "artifact") {
    assert.equal(receipt.result.artifact.kind, "card_candidates");
  }

  // needs_attention 且确实一张都不可审：领域已给终局结论，仍是 failed。
  const attention = fakeTx([[{ ...delivered, status: "needs_attention", reviewableCandidate: false }]]);
  assert.deepEqual((await readOperationResultReceipt(attention.executor, cardRequest())).kind, "failed");
});

test("needs_attention 没有可审候选时是 failed，不是仍在等", async () => {
  const { executor } = fakeTx([[{ ...delivered, status: "needs_attention", reviewableCandidate: false }]]);
  assert.deepEqual((await readOperationResultReceipt(executor, cardRequest())).kind, "failed");
});

test("零推荐是正常收口，理由取已保存领域事件并按上限收窄", async () => {
  const tooMany = Array.from({ length: 25 }, (_, i) => `reason_${i}`);
  const { executor, texts } = fakeTx([
    [{ ...delivered, status: "no_cards_recommended", reviewableCandidate: false }],
    [{ reasonCodes: [...tooMany, "x".repeat(250)] }],
  ]);
  const receipt = await readOperationResultReceipt(executor, cardRequest());
  assert.equal(receipt.kind, "result");
  if (receipt.kind !== "result") return;
  assert.equal(receipt.result.kind, "no_cards_recommended");
  if (receipt.result.kind !== "no_cards_recommended") return;
  assert.equal(receipt.result.reasonCodes.length, 20, "理由条数上限");
  assert.ok(receipt.result.reasonCodes.every(code => code.length <= 100), "每条理由长度上限");
  assert.match(texts[1]!, /card_generation\.no_cards_recommended/, "理由必须来自已保存领域事件");
});

test("身份或冻结材料对不上时没有可核对事实，不算失败", async () => {
  const missing = fakeTx([[]]);
  assert.deepEqual((await readOperationResultReceipt(missing.executor, cardRequest())).kind, "pending");

  const otherNote = fakeTx([[{ ...delivered, noteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]]);
  assert.deepEqual((await readOperationResultReceipt(otherNote.executor, cardRequest())).kind, "failed");
});

test("capability 与 execution 必须同时对上才走 card 分支", async () => {
  const wrongCapability = fakeTx([[delivered]]);
  assert.deepEqual(
    (await readOperationResultReceipt(wrongCapability.executor, cardRequest({ capability: "note_overview_generate" }))).kind,
    "pending",
  );
  assert.equal(wrongCapability.texts.length, 0, "错配不该去查制卡表");
});

test("note 三类仍走原来的四层绑定：未登记 capability 永远拿不到产物", async () => {
  const jobRequest = {
    capability: "note_overview_generate",
    execution: { kind: "job" as const, id: JOB },
    scope: SCOPE, inputs: INPUTS,
  };
  const unregistered = fakeTx([[]]);
  assert.equal((await readOperationResultReceipt(unregistered.executor, { ...jobRequest, capability: "note_unknown_generate" })).kind, "pending");
  assert.equal(unregistered.texts.length, 0, "未登记 capability 不该发查询");

  const found = fakeTx([[{ artifact: { kind: "note_overview", id: "55555555-5555-4555-8555-555555555555",
    jobId: JOB, noteId: NOTE, noteVersionId: NOTE_VERSION } }]]);
  const receipt = await readOperationResultReceipt(found.executor, jobRequest);
  assert.equal(receipt.kind, "result");

  // 另一张 job 的产物挂在这次执行上：宁可当没有，也不读出冒名成果。
  const mismatch = fakeTx([[{ artifact: { kind: "note_overview", id: "55555555-5555-4555-8555-555555555555",
    jobId: "aaaa1111-1111-4111-8111-111111111111", noteId: NOTE, noteVersionId: NOTE_VERSION } }]]);
  assert.deepEqual((await readOperationResultReceipt(mismatch.executor, jobRequest)).kind, "pending");

  // card 执行体落到 note 分支上不产结果。
  const crossed = fakeTx([[]]);
  assert.deepEqual((await readOperationResultReceipt(crossed.executor,
    { ...jobRequest, execution: { kind: "card_generation", id: OTHER_CARD_RUN } })).kind, "pending");
});
