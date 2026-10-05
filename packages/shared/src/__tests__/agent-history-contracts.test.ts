import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_RUN_HISTORY_MAX_LIMIT, AGENT_RUN_LIST_DEFAULT_LIMIT, AGENT_RUN_LIST_MAX_LIMIT,
  agentRunHistoryQueryV1Schema, agentRunHistoryV1Schema, agentRunListCursorV1Schema,
  agentRunListQueryV1Schema, agentRunListV1Schema, agentRunRevisionV1Schema,
} from "../contracts/agent-contracts.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const ARTIFACT = {
  kind: "note_overview" as const,
  id: "55555555-5555-4555-8555-555555555555",
  jobId: "66666666-6666-4666-8666-666666666666",
  noteId: "77777777-7777-4777-8777-777777777777",
  noteVersionId: "88888888-8888-4888-8888-888888888888",
};

/** 不在 helper 里 parse：非法覆盖值要能流进 safeParse，否则断言测不到合同。 */
function revision(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, runId: RUN, revision: 1, goal: "整理成速看", status: "completed", conversationId: null,
    inputs: [], operations: [], artifacts: [], summary: "做好了", error: null,
    modelCalls: 3, maxModelCalls: 16, startedAt: "2026-10-04T01:00:00.000000Z",
    lastActiveAt: "2026-10-04T01:05:00.000000Z",
    recordedAt: "2026-10-04T01:06:00.000000Z", supersededByRevision: 2, ...overrides,
  };
}
function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION, runId: RUN, revision: 1,
    scope: { workspaceId: WORKSPACE, userId: USER },
    capability: "note_overview_generate", execution: { kind: "job", id: ARTIFACT.jobId }, status: "succeeded",
    lastEventSeq: 2, result: { kind: "artifact", artifact: ARTIFACT }, error: null, ...overrides,
  };
}
function history(items: unknown[], rest: Record<string, unknown> = {}) {
  return { version: 1, runId: RUN, currentRevision: 2, items,
    nextBeforeRevision: null, unrecordedRevisions: [], ...rest };
}

test("list 查询：默认 20、上限 50，游标与多余参数一律完整校验", () => {
  assert.equal(agentRunListQueryV1Schema.parse({}).limit, AGENT_RUN_LIST_DEFAULT_LIMIT);
  assert.equal(agentRunListQueryV1Schema.parse({ limit: "50" }).limit, AGENT_RUN_LIST_MAX_LIMIT);
  assert.equal(agentRunListQueryV1Schema.parse({}).cursor, undefined);
  for (const bad of [{ limit: "0" }, { limit: "51" }, { limit: "abc" }, { limit: "1.5" }, { cursor: "" }, { cursor: "x".repeat(513) }])
    assert.equal(agentRunListQueryV1Schema.safeParse(bad).success, false, JSON.stringify(bad));
  // 客户端自称的空间/用户不是这个合同的输入：多一个键就整份拒掉。
  assert.equal(agentRunListQueryV1Schema.safeParse({ workspaceId: WORKSPACE }).success, false);
  assert.equal(agentRunListQueryV1Schema.safeParse({ userId: USER }).success, false);
});

test("list 游标载荷缺一项、多一项都不作数", () => {
  const valid = { version: 1, workspaceId: WORKSPACE, userId: USER,
    updatedAt: "2026-10-04T01:00:00.123456Z", runId: RUN };
  assert.equal(agentRunListCursorV1Schema.safeParse(valid).success, true);
  assert.equal(agentRunListCursorV1Schema.safeParse({ ...valid, runId: undefined }).success, false);
  assert.equal(agentRunListCursorV1Schema.safeParse({ ...valid, version: 2 }).success, false);
  assert.equal(agentRunListCursorV1Schema.safeParse({ ...valid, extra: 1 }).success, false);
  // 微秒尾巴必须留在游标里：用 JS Date 会把它抹成毫秒。
  assert.match(agentRunListCursorV1Schema.parse(valid).updatedAt, /\.123456Z$/);
});

test("列表响应必须显式给出 nextCursor，没有更早一页时为 null", () => {
  const run = { version: 1, runId: RUN, identityId: USER, revision: 1, goal: "整理成速看", status: "queued",
    conversationId: null, inputs: [], operations: [], artifacts: [], summary: null, error: null,
    modelCalls: 0, maxModelCalls: 16, createdAt: "2026-10-04T01:00:00.000Z", updatedAt: "2026-10-04T01:00:00.000Z" };
  assert.equal(agentRunListV1Schema.safeParse({ version: 1, items: [run] }).success, false, "缺 nextCursor 不能通过");
  assert.equal(agentRunListV1Schema.safeParse({ version: 1, items: [run], nextCursor: null }).success, true);
  assert.equal(agentRunListV1Schema.safeParse({ version: 1, items: [], nextCursor: "" }).success, false);
  assert.equal(agentRunListV1Schema.safeParse({
    version: 1, items: Array.from({ length: AGENT_RUN_LIST_MAX_LIMIT + 1 }, () => run), nextCursor: null,
  }).success, false, "一页不得超过上限 50");
});

test("历史查询：默认一页 20、按 revision 往回翻，越界游标不作数", () => {
  assert.equal(agentRunHistoryQueryV1Schema.parse({}).limit, 20);
  assert.equal(agentRunHistoryQueryV1Schema.parse({ beforeRevision: "4", limit: "5" }).beforeRevision, 4);
  for (const bad of [{ beforeRevision: "0" }, { beforeRevision: "-1" }, { beforeRevision: "1.5" }, { limit: "51" }, { offset: "10" }])
    assert.equal(agentRunHistoryQueryV1Schema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("operation 自带的一致性：结果必须属于它自己的 execution 与 capability", () => {
  const CARD_RUN = "99999999-9999-4999-8999-999999999999";
  const CARD_ARTIFACT = { kind: "card_candidates", id: CARD_RUN, noteId: ARTIFACT.noteId, noteVersionId: ARTIFACT.noteVersionId };
  const cardOperation = (overrides: Record<string, unknown> = {}) => operation({
    capability: "card_generation_generate", execution: { kind: "card_generation", id: CARD_RUN },
    result: { kind: "artifact", artifact: CARD_ARTIFACT }, ...overrides,
  });
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [cardOperation()] })).success, true);
  // capability 不对：执行体对了也不能结案。
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [cardOperation({ capability: "note_overview_generate" })] })).success, false);
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [cardOperation({
    result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] } })] })).success, true);
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [cardOperation({
    capability: "note_overview_generate",
    result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] } })] })).success, false);
});

test("operation 自带的一致性：结果必须属于它自己的 execution", () => {
  const base = operation();
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [base] })).success, true);
  // 笔记产物挂在制卡执行体上：不成立。
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [operation({
    execution: { kind: "card_generation", id: "99999999-9999-4999-8999-999999999999" } })] })).success, false);
  // 制卡候选挂在 job 执行体上：同样不成立。
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [operation({
    result: { kind: "artifact", artifact: { kind: "card_candidates", id: ARTIFACT.id, noteId: ARTIFACT.noteId, noteVersionId: ARTIFACT.noteVersionId } } })] })).success, false);
  // 无卡推荐不配 job 执行体：正常收口也不是笔记产物的收口。
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [operation({
    result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] } })] })).success, false);
  const CARD_CAPABILITY = "card_generation_generate";
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [operation({
    capability: CARD_CAPABILITY,
    execution: { kind: "card_generation", id: ARTIFACT.id },
    result: { kind: "artifact", artifact: { kind: "card_candidates", id: ARTIFACT.id, noteId: ARTIFACT.noteId, noteVersionId: ARTIFACT.noteVersionId } } })] })).success, true);
  // 理由条数与长度有上限：领域事件可能被写坏，投影不能因此被撑破。
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [operation({
    capability: CARD_CAPABILITY,
    execution: { kind: "card_generation", id: ARTIFACT.id },
    result: { kind: "no_cards_recommended", reasonCodes: Array.from({ length: 21 }, (_, i) => `c${i}`) } })] })).success, false);
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ operations: [operation({
    capability: CARD_CAPABILITY,
    execution: { kind: "card_generation", id: ARTIFACT.id },
    result: { kind: "no_cards_recommended", reasonCodes: ["x".repeat(101)] } })] })).success, false);
});

test("历史项：形状与时间各自合法，跨字段的一致性写在历史这一层", () => {
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ recordedAt: null, supersededByRevision: null })).success, true);
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ summary: null, error: "有一部分没做成" })).success, true);
  // 部署前走过的版本没有确切起点：给 null 是诚实，编一个时间不是。
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ startedAt: null })).success, true);
  assert.equal(agentRunRevisionV1Schema.safeParse(revision({ recordedAt: "2026-10-04T01:06:00.000000", supersededByRevision: null })).success, false);
  // 当前版没有存档时间、被替换的版本必须有：两者要么同时有，要么同时没有。
  assert.equal(agentRunHistoryV1Schema.safeParse(history([revision({ revision: 2, recordedAt: null, supersededByRevision: null })])).success, true);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([revision({ revision: 2, recordedAt: null, supersededByRevision: 3 })])).success, false);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([revision({ recordedAt: "2026-10-04T01:06:00.000000Z", supersededByRevision: null })])).success, false);
  // 「替代它的版本必须更新」。
  assert.equal(agentRunHistoryV1Schema.safeParse(history([
    revision({ revision: 2, recordedAt: null, supersededByRevision: null }),
    revision({ revision: 1, supersededByRevision: 1 }),
  ])).success, false);
});

test("历史响应：跨 revision 混入、重复、伪报缺省都拒绝", () => {
  const current = revision({ revision: 2, recordedAt: null, supersededByRevision: null,
    operations: [operation({ revision: 2 })] });
  const older = revision({ revision: 1 });
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, older])).success, true);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([older, current])).success, false, "必须严格倒序");
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, older, older])).success, false, "同一 revision 不能出现两次");
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, { ...older, runId: OPERATION }])).success, false);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, { ...older, revision: 3 }])).success, false);
  // 旧版不能塞进新版的 operation/artifact。
  assert.equal(agentRunHistoryV1Schema.safeParse(history([
    current, revision({ revision: 1, operations: [operation({ revision: 2 })] }),
  ])).success, false);
  // 已经存档的 revision 不能被说成没存档。
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, older], { unrecordedRevisions: [1] })).success, false);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current], { unrecordedRevisions: [1] })).success, true);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current], { unrecordedRevisions: [2] })).success, false,
    "当前版本一定读得到");
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, older], { nextBeforeRevision: 1 })).success, true);
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current, older], { nextBeforeRevision: 2 })).success, false,
    "下一页必须指向更早");
  assert.equal(agentRunHistoryV1Schema.safeParse(history([current], {
    nextBeforeRevision: 1, unrecordedRevisions: Array.from({ length: AGENT_RUN_HISTORY_MAX_LIMIT + 1 }, (_, i) => i + 1),
  })).success, false, "缺省名单必须和页大小同阶，不许无界膨胀");
});