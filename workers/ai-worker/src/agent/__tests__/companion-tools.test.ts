/**
 * 目标要求只能来自用户本轮原话（方案 42 第一批 A 的验收回归）。
 *
 * 实测事故：用户说「把这篇欧姆定律笔记往外拓展，准备一批可挑选的知识草稿……
 * 我自己挑选，不要自动收下或制卡」，模型把参数 goal 改写成
 * 「学习卡候选要点，只依据正文，不引入新知识」，后台照着错的 goal
 * 只交付了文字。这里锁住三件事：模型改不动要求、原话原样进持久 create
 * 输入、历史/页面不替代原话，以及没有明确交代时不自动启动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunV1 } from "@ailearn/shared/agent-contracts";
import type { AgentEventContext } from "../../handlers/companion-read-tools.ts";
import {
  executeAgentGoalTool, goalRequestFromUserTurn,
  type AgentGoalToolStore,
} from "../companion-tools.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TURN_RUN = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const NOTE = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const INPUT = { kind: "note_version" as const, noteId: NOTE, noteVersionId: VERSION };

const USER_TURN = "把这篇欧姆定律笔记往外拓展，准备一批可挑选的知识草稿。"
  + "先只生成草稿，完成后留在对话手记，我自己挑选，不要自动收下或制卡。";

type CreateCall = { scope: unknown; input: { requestId: string; goal: string; inputs: unknown[]; conversationId?: string } };
function harness(options: { userText?: unknown; pageContext?: unknown } = {}) {
  const creates: CreateCall[] = [];
  const store = {
    async create(scope: unknown, input: CreateCall["input"]) {
      creates.push({ scope, input });
      return { version: 1, runId: "77777777-7777-4777-8777-777777777777", revision: 1, goal: input.goal,
        status: "queued", artifacts: [], inputs: [], operations: [], conversationId: null,
        summary: null, error: null, identityId: USER, modelCalls: 0, maxModelCalls: 16,
        createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" } satisfies AgentRunV1;
    },
    async list() { throw new Error("不该读目标目录"); },
    async revise() { throw new Error("本组不测 revise"); },
    async control() { throw new Error("本组不测 control"); },
  } satisfies AgentGoalToolStore;
  const event = {
    ctx: { workspaceId: WORKSPACE },
    read: {
      userId: USER, runId: TURN_RUN, conversationId: CONVERSATION,
      userText: ("userText" in options ? options.userText : USER_TURN) as string,
      pageContext: options.pageContext ?? null,
    },
  } as unknown as AgentEventContext;
  return { event, store, creates };
}

test("本轮原话原样进入持久 create 输入：材料、版本与 requestId 冻结照旧", async () => {
  const { event, store, creates } = harness();
  const result = await executeAgentGoalTool(event, "agent_start_goal", { inputs: [INPUT] }, store);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.input.goal, USER_TURN, "一个字都不能被改写、概括或补全");
  assert.deepEqual(creates[0]!.input.inputs, [INPUT], "材料与版本按实际读取冻结");
  assert.equal(creates[0]!.input.requestId, TURN_RUN, "requestId 绑定本轮，模型修复重试不重复接");
  assert.equal(creates[0]!.input.conversationId, CONVERSATION);
  assert.deepEqual(creates[0]!.scope, { workspaceId: WORKSPACE, userId: USER });
  assert.equal((result.value as { goal: string }).goal, USER_TURN, "回执里的要求也是原话");
});

test("模型不能通过参数改写目标：带 goal 的调用直接失败，目标一条也没建", async () => {
  const { event, store, creates } = harness();
  for (const smuggled of [
    { inputs: [INPUT], goal: "学习卡候选要点，只依据正文，不引入新知识" },
    { inputs: [INPUT], Goal: USER_TURN },
    { goal: "学习卡候选要点，只依据正文，不引入新知识" },
  ]) {
    await assert.rejects(executeAgentGoalTool(event, "agent_start_goal", smuggled, store));
  }
  assert.equal(creates.length, 0, "参数被拒时不得落库");
});

test("历史与页面都不替代这一轮的要求", async () => {
  const pageContext = {
    pageKind: "note", noteId: NOTE, title: "欧姆定律",
    selectedText: "学习卡候选要点，只依据正文，不引入新知识",
  };
  const { event, store, creates } = harness({ pageContext });
  await executeAgentGoalTool(event, "agent_start_goal", { inputs: [INPUT] }, store);
  assert.equal(creates[0]!.input.goal, USER_TURN, "页面提示与选区都不是要求来源");
});

test("空原话、超长原话和未定位材料均不创建目标", async () => {
  for (const [userText, reason] of [[undefined, "empty"], ["", "empty"], ["   \n ", "empty"],
    ["把".repeat(8_001), "too_long"]] as const) {
    const { event, store, creates } = harness({ userText });
    const result = await executeAgentGoalTool(event, "agent_start_goal", { inputs: [INPUT] }, store);
    assert.equal(creates.length, 0, JSON.stringify(reason));
    assert.equal((result.value as { status: string }).status, "not_executed");
    assert.match((result.value as { reason: string }).reason, /明确交代|太长/);
    assert.equal(goalRequestFromUserTurn(userText).ok, false);
  }
  // 未定位到真实笔记的页面提示不能作为材料引用。
  const { event, store, creates } = harness({ pageContext: { pageKind: "note", title: "欧姆定律" } });
  const result = await executeAgentGoalTool(event, "agent_start_goal", { inputs: [] }, store);
  assert.equal(creates.length, 0);
  assert.equal((result.value as { status: string }).status, "not_executed");
  assert.match((result.value as { reason: string }).reason, /笔记/);
});

test("目标文本的判据就是 create 输入合同本身，不另写一份上限", () => {
  assert.deepEqual(goalRequestFromUserTurn("  整理成速看  "), { ok: true, goal: "整理成速看" });
  assert.equal(goalRequestFromUserTurn(undefined).ok, false);
  assert.equal(goalRequestFromUserTurn("整理".repeat(4_000)).ok, true);
  assert.deepEqual(goalRequestFromUserTurn("整理".repeat(4_001)), { ok: false, reason: "too_long" });
});
