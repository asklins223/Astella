import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assembleCompanionStepRequest, companionStepPolicyText, companionStepToolSurface, companionWebSearchAllowedForStep } from "../agent/companion-agent-step-assembly.ts";
import { companionStepOutputCeiling } from "../turn/companion-dialogue-content.ts";
import type { AgentTurnRequest } from "@astella/shared";
import { companionStepCorrectionMessages } from "../turn/companion-step-plan.ts";

const READ_TOOL = { name: "companion_read_note", description: "读笔记", parameters: {} };
const WEB_TOOL = { name: "agent_web_search", description: "联网", parameters: {} };
const WRITE_TOOL = { name: "companion_edit_note", description: "改笔记", parameters: {} };
const attention = {
  version: 1, requestHash: "abc", intent: "question", toolUse: "uncertain", subjects: [],
  goalRelation: "unrelated", goalReference: null, candidateOperations: [], ambiguities: [], status: "interpreted",
  voiceStyle: { decision: "none" },
} as never;

test("host occasions do not inherit the user-dialogue continuation task", () => {
  const base = { permissionLevel: "full", stepBudget: Infinity, finalAnswerOnly: false,
    offeredToolNames: ["companion_read_note"], writingAnnotation: false, completeNoteReply: false };
  for (const attentionIntent of ["conversation", "question", "task"]) for (const toolCount of [0, 3]) {
    const policy = companionStepPolicyText({ ...base, attentionIntent, toolCount, requestSource: "host_observation" });
    assert.match(policy, /当前任务是处理末尾 hostObservation/);
    assert.doesNotMatch(policy, /把最后一条消息作为对方向你说的话来接|每次工具返回后都回到本轮最后一条用户问题/);
  }
  const userPolicy = companionStepPolicyText({ ...base, attentionIntent: "conversation", toolCount: 3, requestSource: "user" });
  assert.match(userPolicy, /把最后一条消息作为对方向你说的话来接/);
  const currentRequest = { role: "system" as const, hostObservation: true as const, content: "app.started: current occasion" };
  const correction = companionStepCorrectionMessages({ currentRequest, instruction: "核对当前时刻", alreadyDisplayed: false });
  assert.deepEqual(correction.at(-1), currentRequest, "repair keeps host authority and the exact observation");
  assert.match(String(correction[0]?.content), /当前宿主观察/);
  assert.doesNotMatch(String(correction[0]?.content), /完整回答当前问题/);
});

test("终答步收起工具时绝不留下空工具面配 required 的那一对", () => {
  const shape = companionStepToolSurface({
    toolDefinitions: [READ_TOOL, WRITE_TOOL] as never[], webSearchAllowedForStep: false,
    finalAnswerOnly: true, requiresTool: true, toolCallCount: 0,
  });
  assert.deepEqual(shape.tools, []);
  assert.equal(shape.toolChoice, "auto", "tools 空 + required 是 provider 直接 400 的那一对");
});

test("联网工具四样都真才留下，其他工具不受它影响", () => {
  const cases = [
    { accountEnabled: true, constraintsEnabled: true, limit: null, used: 0, expected: true },
    { accountEnabled: false, constraintsEnabled: true, limit: null, used: 0, expected: false },
    { accountEnabled: true, constraintsEnabled: false, limit: null, used: 0, expected: false },
    { accountEnabled: true, constraintsEnabled: true, limit: 2, used: 2, expected: false },
    { accountEnabled: true, constraintsEnabled: true, limit: 2, used: 1, expected: true },
  ];
  for (const input of cases) {
    const shape = companionStepToolSurface({
      toolDefinitions: [READ_TOOL, WEB_TOOL] as never[],
      webSearchAllowedForStep: companionWebSearchAllowedForStep(input),
      finalAnswerOnly: false, requiresTool: false, toolCallCount: 0,
    });
    assert.equal(shape.tools.some(tool => tool.name === "agent_web_search"), input.expected && webSearchServiceUp(),
      `账号 ${input.accountEnabled} 外发 ${input.constraintsEnabled} 额度 ${input.used}/${input.limit}`);
    assert.ok(shape.tools.some(tool => tool.name === "companion_read_note"), "读工具永远在");
  }
});

// 服务可用性由环境决定，测试里跟着它走，不另写一份判据。
function webSearchServiceUp(): boolean {
  return companionWebSearchAllowedForStep({ accountEnabled: true, constraintsEnabled: true, limit: null, used: 0 });
}

test("原句批注与整篇交付各自拿到需要完整交付的那句指引", () => {
  const base = { permissionLevel: "full", toolCount: 3, stepBudget: 8, finalAnswerOnly: false, attentionIntent: "question", offeredToolNames: ["companion_read_note"] };
  const annotation = companionStepPolicyText({ ...base, writingAnnotation: true, completeNoteReply: false });
  assert.match(annotation, /companion_write_annotation/);
  assert.match(annotation, /聊天正文不会保存成解释/);
  assert.ok(!annotation.includes("这轮正文会完整保存为笔记学习内容"));
  const noteReply = companionStepPolicyText({ ...base, writingAnnotation: false, completeNoteReply: true });
  assert.match(noteReply, /用连续最终正文完整交付/);
  assert.ok(!noteReply.includes("companion_write_annotation 独立写入"));
  const plain = companionStepPolicyText({ ...base, writingAnnotation: false, completeNoteReply: false });
  assert.ok(!plain.includes("批注正文") && !plain.includes("分句发言工具"));
});

test("投机那一步的请求原样复用，不重新装配一遍", () => {
  const prefetched = { role: "companion_agent", systemPrompt: "speculative", messages: [], tools: [], maxTokens: 100 } as unknown as AgentTurnRequest;
  const assembled = assembleCompanionStepRequest({
    turnPolicy: "policy", runtimePolicy: "runtime", executionGuidance: "", attention,
    messages: [], tools: [READ_TOOL] as never[], toolChoice: "auto", disableThinking: false,
    provider: {} as never, temperature: 0.9, prefetchedRequest: prefetched,
  });
  assert.equal(assembled, prefetched, "复用必须是同一份请求：改过就等于投机白做");
});

test("现算的请求把注意力数据转义进系统提示，输出额度只跟档案声明", () => {
  const provider = { id: "p", modelId: "m", getCapabilities: () => ({ maxOutputTokens: 32_000 }) } as never;
  const escaped = { ...attention as object, subjects: ["<script>笔记</script>"] } as never;
  const assembled = assembleCompanionStepRequest({
    turnPolicy: "相处政策", runtimePolicy: "执行政策", executionGuidance: "讲解复核",
    attention: escaped,
    messages: [{ role: "user", content: "递归怎么理解" }], tools: [READ_TOOL] as never[],
    toolChoice: "auto", disableThinking: true, provider, temperature: 0.9,
  });
  assert.equal(assembled.maxTokens, companionStepOutputCeiling(provider), "这一步能说多少只由档案声明");
  assert.equal(assembled.temperature, 0.9);
  assert.equal(assembled.disableThinking, true);
  assert.match(assembled.systemPrompt, /相处政策/);
  assert.match(assembled.systemPrompt, /执行政策\n讲解复核/);
  assert.match(assembled.systemPrompt, /current_turn_interpretation_data/);
  assert.ok(!assembled.systemPrompt.includes("<script>"), "分类数据里的尖括号必须转义，不能成为提示结构");
});

/**
 * 调用侧那一格：政策文本按「这一步真的发下去几件工具」选分支，不是按权限档算出来的全量清单。
 *
 * 2026-10-16 审出来的接线错误：终答步（`finalAnswerOnly`）的 `tools` 已经是空的，而运行时
 * 传的是 `toolDefinitions.length`，于是 system 里留着「只能调用工具列表中的工具」，工具列表
 * 却是空的；`companionStepRuntimePolicy` 里那段「本轮没有可调用工具，只依据当前已提供的材料
 * 回答」也永远不可达。政策函数自己的单测全绿——它只看得见传进来的数字。
 */
test("政策文本按这一步真的发下去的工具面判空，不按权限档的全量清单判", () => {
  const source = readFileSync(new URL("../agent/companion-agent-runtime.ts", import.meta.url), "utf8");
  const start = source.indexOf("companionStepPolicyText({");
  assert.notEqual(start, -1, "找不到每步政策的接线点");
  const wiring = source.slice(start, start + 700);
  const toolCount = wiring.match(/toolCount:\s*([^,\n]+)/)?.[1]?.trim() ?? "";
  assert.match(toolCount, /toolsOfferedThisStep\.length/,
    "要按这一步真的发下去的工具面判空");
  assert.doesNotMatch(toolCount, /toolDefinitions\.length/,
    "全量清单在终答步不为 0，用它会让「本轮没有工具」那段永远不可达");
  // 终答步的组合必须自洽：空工具面 + 「不再提供工具」的那句，且不再是工具用法政策。
  const finalStep = companionStepPolicyText({ permissionLevel: "full", toolCount: 0, stepBudget: 4,
    finalAnswerOnly: true, attentionIntent: "question", offeredToolNames: [],
    writingAnnotation: false, completeNoteReply: false });
  assert.match(finalStep, /本轮没有可调用工具/);
  assert.match(finalStep, /这是最后一步：不再提供工具/);
  assert.doesNotMatch(finalStep, /只能调用工具列表中的工具/);
});
