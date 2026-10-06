import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import {
  AgentStoreError, agentHistoryRevisionWindow, decodeAgentRunListCursor, encodeAgentRunListCursor,
  projectAgentRunHistoryV1, resolveAgentHistoryLimit, resolveAgentRunListLimit,
  type AgentRevisionRow,
} from "@astella/agent-host";
import { createAgentRouteHandlers } from "../routes.ts";
import { closeDatabase } from "../../../db/client.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "11111111-1111-4111-8111-111111111112";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "22222222-2222-4222-8222-222222222223";
const RUN = "33333333-3333-4333-8333-333333333333";
const SCOPE = { workspaceId: WORKSPACE, userId: USER };

type Call = { name: string; scope: unknown; args: unknown[] };
function harness(behaviour: {
  list?: (query: unknown) => unknown; history?: (query: unknown) => unknown;
  get?: () => unknown;
} = {}) {
  const calls: Call[] = [];
  const handlers = createAgentRouteHandlers({
    async list(scope, query) {
      calls.push({ name: "list", scope, args: [query] });
      if (behaviour.list) return behaviour.list(query);
      return { version: 1, items: [], nextCursor: null };
    },
    async get(scope, id) {
      calls.push({ name: "get", scope, args: [id] });
      return behaviour.get ? behaviour.get() : { version: 1, runId: id };
    },
    async create() { throw new Error("not used"); },
    async revise() { throw new Error("not used"); },
    async control() { throw new Error("not used"); },
    async history(scope, id, query) {
      calls.push({ name: "history", scope, args: [id, query] });
      if (behaviour.history) return behaviour.history(query);
      return { version: 1, runId: id, currentRevision: 1, items: [], nextBeforeRevision: null, unrecordedRevisions: [] };
    },
  });
  const app = Fastify();
  app.addHook("preHandler", async req => { req.session = { ...SCOPE, workspaceEpoch: 1 }; });
  app.get("/agent/runs", handlers.list);
  app.get("/agent/runs/:runId", handlers.get);
  app.get("/agent/runs/:runId/history", handlers.history);
  return { app, calls };
}
after(async () => { await closeDatabase(); });

function revisionRow(revision: number): AgentRevisionRow {
  return {
    revision, goal: `第 ${revision} 版的要求`, status: "completed", conversation_id: null, inputs: [],
    summary: "旧结果", error: null, model_calls: 2, max_model_calls: 16,
    started_at: "2026-10-04T00:00:00.000000Z", last_active_at: "2026-10-04T00:01:00.000000Z",
    recorded_at: "2026-10-04T00:02:00.000000Z", superseded_by_revision: revision + 1,
  };
}

test("不带参数就是今天的调用：默认第一页 20 条，作用域只来自会话", async () => {
  const { app, calls } = harness();
  const response = await app.inject({ method: "GET", url: "/agent/runs" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0]?.args[0], { limit: 20 });
  assert.deepEqual(calls[0]?.scope, SCOPE, "空间与用户必须来自会话，不来自查询串");
  assert.deepEqual(response.json(), { version: 1, items: [], nextCursor: null });
  await app.close();
});

test("limit 与 cursor 原样交给 store，越界与客户端自带作用域直接 400", async () => {
  const { app, calls } = harness({ list: () => ({ version: 1, items: [], nextCursor: "opaque-cursor" }) });
  assert.deepEqual((await app.inject({ url: "/agent/runs?limit=50&cursor=opaque-cursor" })).json().nextCursor, "opaque-cursor");
  assert.deepEqual(calls[0]?.args[0], { limit: 50, cursor: "opaque-cursor" });
  for (const url of [
    "/agent/runs?limit=51", "/agent/runs?limit=0", "/agent/runs?limit=abc",
    `/agent/runs?workspaceId=${OTHER_WORKSPACE}`, `/agent/runs?userId=${OTHER_USER}`,
    `/agent/runs?cursor=${encodeURIComponent("not-a-cursor")}&extra=1`,
  ]) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error, "invalid_request", url);
  }
  assert.equal(calls.length, 1, "被拒的查询不许走到 store");
  await app.close();
});

test("store 判废游标时是 400 而不是悄悄退回第一页", async () => {
  const { app } = harness({ list: () => { throw new AgentStoreError(400, "invalid_cursor", "这个位置已经读不到了，请从头再看一次。"); } });
  const response = await app.inject({ url: "/agent/runs?cursor=whatever" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "invalid_cursor");
  await app.close();
});

/**
 * 错误信封现在由 `lib/error-envelope.ts` 的 buildSimpleErrorBody 生成（这条断言就是
 * 收口后的**行为自证**，不是新形状的许可）：状态码与错误码原样出去，body 恰好是
 * `{ error, message }` 两键——不多带字段，也不把 5xx 的内部细节回给客户端。
 *
 * 收口前这里是手写的 `{ error: error.code, message: error.message }`，对 4xx 逐字相同；
 * 差别只在 5xx：手写版会把 store 的原始 message 透出去。
 */
test("store 错误的信封：4xx 逐字不变，5xx 不泄露内部细节", async () => {
  const client = harness({ list: () => { throw new AgentStoreError(400, "invalid_cursor", "这个位置已经读不到了。"); } });
  const clientResponse = await client.app.inject({ url: "/agent/runs?cursor=x" });
  assert.equal(clientResponse.statusCode, 400);
  assert.deepEqual(clientResponse.json(), { error: "invalid_cursor", message: "这个位置已经读不到了。" });
  await client.app.close();

  // 破坏样本：store 抛一个带连接串的 5xx。状态码与错误码要留住，message 必须脱敏。
  const server = harness({
    get: () => { throw new AgentStoreError(500, "internal", "connect ECONNREFUSED 10.0.0.5:5432"); },
  });
  const serverResponse = await server.app.inject({ url: `/agent/runs/${RUN}` });
  assert.equal(serverResponse.statusCode, 500);
  assert.equal(serverResponse.json().error, "internal");
  assert.equal(serverResponse.json().message, "服务器内部错误");
  assert.doesNotMatch(JSON.stringify(serverResponse.json()), /ECONNREFUSED|10\.0\.0\.5/);
  await server.app.close();
});

test("history 查询按 revision 分页，跨用户的 run 与 get 一样读不到", async () => {
  const { app, calls } = harness({
    history: () => ({ version: 1, runId: RUN, currentRevision: 7, items: [], nextBeforeRevision: 3, unrecordedRevisions: [4] }),
    get: () => { throw new AgentStoreError(404, "run_not_found", "这件事现在读不到。"); },
  });
  const page = await app.inject({ url: `/agent/runs/${RUN}/history?limit=2&beforeRevision=5` });
  assert.equal(page.statusCode, 200);
  assert.deepEqual(calls[0]?.args, [RUN, { limit: 2, beforeRevision: 5 }]);
  assert.deepEqual(calls[0]?.scope, SCOPE);
  assert.deepEqual(page.json(), { version: 1, runId: RUN, currentRevision: 7, items: [], nextBeforeRevision: 3, unrecordedRevisions: [4] });
  assert.deepEqual((await app.inject({ url: `/agent/runs/${RUN}/history` })).statusCode, 200);
  assert.deepEqual(calls[1]?.args, [RUN, { limit: 20 }], "默认一页 20 条");
  assert.equal((await app.inject({ url: `/agent/runs/${RUN}/history?beforeRevision=0` })).statusCode, 400);
  assert.equal((await app.inject({ url: `/agent/runs/${RUN}/history?limit=51` })).statusCode, 400);
  assert.equal((await app.inject({ url: "/agent/runs/not-a-uuid/history" })).statusCode, 400);
  assert.equal((await app.inject({ url: `/agent/runs/${RUN}` })).statusCode, 404);
  assert.equal(calls.filter(call => call.name === "history").length, 2, "被拒的 history 查询不许走到 store");
  await app.close();
});

test("列表游标：作用域不符、形状残缺、被篡改都整体作废", () => {
  const cursor = encodeAgentRunListCursor(SCOPE, { updatedAt: "2026-10-04T01:00:00.123456Z", runId: RUN });
  assert.deepEqual(decodeAgentRunListCursor(cursor, SCOPE), { updatedAt: "2026-10-04T01:00:00.123456Z", runId: RUN });
  assert.equal(decodeAgentRunListCursor(cursor, { ...SCOPE, userId: OTHER_USER }), null, "别人的游标读不到我的目标");
  assert.equal(decodeAgentRunListCursor(cursor, { ...SCOPE, workspaceId: OTHER_WORKSPACE }), null, "另一个空间的游标也不行");
  assert.equal(decodeAgentRunListCursor("not-base64url-json", SCOPE), null);
  assert.equal(decodeAgentRunListCursor(Buffer.from("{}").toString("base64url"), SCOPE), null, "字段不全");
  assert.equal(decodeAgentRunListCursor("x".repeat(513), SCOPE), null, "超长游标");
  const tampered = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(decodeAgentRunListCursor(
    Buffer.from(JSON.stringify({ ...tampered, extra: 1 })).toString("base64url"), SCOPE), null);
  assert.equal(decodeAgentRunListCursor(
    Buffer.from(JSON.stringify({ ...tampered, updatedAt: "2026-10-04" })).toString("base64url"), SCOPE), null);
});

test("直接调用 store 的那条路径也拿不到失控的 limit", () => {
  assert.equal(resolveAgentRunListLimit(undefined), 20);
  assert.equal(resolveAgentRunListLimit("50"), 50);
  assert.equal(resolveAgentRunListLimit(999), 50);
  assert.equal(resolveAgentRunListLimit(0), 1);
  assert.equal(resolveAgentRunListLimit("nonsense"), 20);
  assert.equal(resolveAgentHistoryLimit(undefined), 20);
  assert.equal(resolveAgentHistoryLimit(51), 50);
});

test("历史页只覆盖一页的 revision 号，缺省名单不越界也不虚报", () => {
  // 0373 之后 `agent_operations` 存的是包好的 `result`，执行体由 job_id /
  // card_generation_run_id 两列 XOR 给出；这一格钉的是**读投影**的换算，不是某一列。
  const operations = [
    { id: "44444444-4444-4444-8444-000000000001", revision: 3, capability: "note_overview_generate",
      job_id: "66666666-6666-4666-8666-666666666661",
      card_generation_run_id: null, card_generation_outbox_id: null,
      status: "succeeded", last_event_seq: 1,
      result: { kind: "artifact", artifact: {
        kind: "note_overview", id: "55555555-5555-4555-8555-555555555551",
        jobId: "66666666-6666-4666-8666-666666666661",
        noteId: "77777777-7777-4777-8777-777777777771", noteVersionId: "88888888-8888-4888-8888-888888888881" } },
      error: null },
    // 制卡那一档：执行体落在 card_generation_run_id 上，job_id 为空；产物没有 jobId。
    { id: "44444444-4444-4444-8444-000000000002", revision: 3, capability: "card_generation_generate",
      job_id: null,
      card_generation_run_id: "99999999-9999-4999-8999-999999999991",
      card_generation_outbox_id: "aaaa9999-9999-4999-8999-999999999991",
      status: "succeeded", last_event_seq: 1,
      result: { kind: "artifact", artifact: {
        kind: "card_candidates", id: "99999999-9999-4999-8999-999999999991",
        noteId: "77777777-7777-4777-8777-777777777771", noteVersionId: "88888888-8888-4888-8888-888888888881" } },
      error: null },
    // 零推荐也是成功收口：它有 result，但**不是** artifact，所以不进 artifacts 投影。
    { id: "44444444-4444-4444-8444-000000000003", revision: 3, capability: "card_generation_generate",
      job_id: null,
      card_generation_run_id: "99999999-9999-4999-8999-999999999992",
      card_generation_outbox_id: "aaaa9999-9999-4999-8999-999999999992",
      status: "succeeded", last_event_seq: 1,
      result: { kind: "no_cards_recommended", reasonCodes: ["source_not_learnable"] },
      error: null },
  ];
  const recorded = [2, 1].map(revision => ({
    revision, goal: `第 ${revision} 版的要求`, status: "completed", conversation_id: null,
    inputs: [], summary: "旧结果", error: null, model_calls: 2, max_model_calls: 16,
    started_at: "2026-10-04T00:00:00.000000Z", last_active_at: "2026-10-04T00:10:00.000000Z",
    recorded_at: "2026-10-04T00:11:00.000000Z", superseded_by_revision: revision + 1,
  }));
  const page = projectAgentRunHistoryV1({
    scope: SCOPE, runId: RUN, currentRevision: 3, topRevision: 3, limit: 20,
    current: { scope: SCOPE, goal: "当前要求", status: "running", conversationId: null, inputs: [],
      summary: null, error: null, modelCalls: 1, maxModelCalls: 16,
      startedAt: "2026-10-04T00:20:00.000000Z", lastActiveAt: "2026-10-04T00:21:00.000000Z" },
    recorded, operations,
  });
  assert.deepEqual(page.items.map(item => item.revision), [3, 2, 1]);
  assert.deepEqual(page.unrecordedRevisions, [], "全部存档过，不能虚报缺省");
  assert.equal(page.nextBeforeRevision, null);
  // 新版的产物不进旧版，旧版也不吞掉自己那一份。
  // 两类产物各一张；零推荐那一行**不**产出一张 artifact——它是成功收口，不是产物。
  assert.deepEqual(page.items[0]?.artifacts.map(a => a.kind), ["note_overview", "card_candidates"]);
  assert.deepEqual(page.items.slice(1).map(item => item.artifacts.length), [0, 0]);
  assert.deepEqual(page.items.slice(1).map(item => item.goal), ["第 2 版的要求", "第 1 版的要求"]);
  // 执行体的 kind 由列给出，不靠「哪一列有值」猜；结果必须逐字属于该执行体。
  assert.deepEqual(page.items[0]?.operations.map(o => o.execution.kind), ["job", "card_generation", "card_generation"]);
  assert.deepEqual(page.items[0]?.operations.map(o => o.result?.kind),
    ["artifact", "artifact", "no_cards_recommended"]);

  const gap = projectAgentRunHistoryV1({
    scope: SCOPE, runId: RUN, currentRevision: 800, topRevision: 800, limit: 20,
    current: { scope: SCOPE, goal: "当前要求", status: "running", conversationId: null, inputs: [],
      summary: null, error: null, modelCalls: 1, maxModelCalls: 16, startedAt: null,
      lastActiveAt: "2026-10-04T00:21:00.000000Z" },
    recorded: [], operations: [],
  });
  assert.deepEqual(gap.items.map(item => item.revision), [800]);
  assert.equal(gap.unrecordedRevisions.length, 19, "只报告本页窗口里的缺省，不做 1..799 的无界遍历");
  assert.deepEqual(gap.unrecordedRevisions, Array.from({ length: 19 }, (_, index) => 781 + index));
  assert.equal(gap.nextBeforeRevision, 780);
  assert.equal(gap.items[0]?.startedAt, null, "部署前开始的版本没有确切起点");
});
test("缺档时翻页：一页只覆盖自己的 revision 号窗口，更早页的存档不漏进来", () => {
  // 与 store.ts 的 SQL 同一对上下界：上界之外（更早）的存档不参与本页。
  function page(currentRevision: number, archived: number[], top: number, limit: number) {
    const window = agentHistoryRevisionWindow(top, limit);
    const includeCurrent = top >= currentRevision;
    const ceiling = includeCurrent ? currentRevision - 1 : window.top;
    const rows = archived.filter(revision => revision >= window.bottom && revision <= ceiling)
      .sort((a, b) => b - a).slice(0, includeCurrent ? limit - 1 : limit)
      .map(revision => revisionRow(revision));
    return projectAgentRunHistoryV1({
      scope: SCOPE, runId: RUN, currentRevision, topRevision: top, limit,
      current: { scope: SCOPE, goal: "当前要求", status: "running", conversationId: null, inputs: [],
        summary: null, error: null, modelCalls: 1, maxModelCalls: 16, startedAt: null,
        lastActiveAt: "2026-10-04T00:04:00.000000Z" },
      recorded: rows, operations: [],
    });
  }
  function walk(currentRevision: number, archived: number[], limit: number) {
    const items: number[] = [], missing: number[] = [];
    let top: number | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const result = page(currentRevision, archived, top ?? currentRevision, limit);
      assert.ok(result.items.length + result.unrecordedRevisions.length <= limit,
        "一页覆盖的 revision 号数不得超过 limit");
      items.push(...result.items.map(item => item.revision));
      missing.push(...result.unrecordedRevisions);
      if (result.nextBeforeRevision === null) break;
      top = result.nextBeforeRevision;
    }
    return { items, missing };
  }
  assert.deepEqual(walk(6, [1, 2, 3, 4, 5], 2), { items: [6, 5, 4, 3, 2, 1], missing: [] });
  // 2、3 没有存档：其余各版仍一页一次，缺档各报一次。
  assert.deepEqual(walk(6, [1, 4, 5], 2), { items: [6, 5, 4, 1], missing: [3, 2] });
  assert.deepEqual(page(6, [1, 4, 5], 4, 2).items.map(item => item.revision), [4],
    "窗口 3..4 里没有第 1 版，它属于更早的一页");
  // 上界之后再无存档时终止，不会拿空页无限往下走。
  assert.deepEqual(walk(3, [], 20), { items: [3], missing: [1, 2] });
  assert.equal(page(3, [], 3, 20).nextBeforeRevision, null);
});
