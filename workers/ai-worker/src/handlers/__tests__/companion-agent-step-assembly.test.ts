import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assembleCompanionStepRequest, companionReplayMessages, companionStepPolicyText, companionStepToolSurface } from "../agent/companion-agent-step-assembly.ts";
import { companionStepOutputCeiling } from "../turn/companion-dialogue-content.ts";
import { companionStepCorrectionMessages } from "../turn/companion-step-plan.ts";
import { companionDirectInterpretation } from "../turn/companion-entry-mode.ts";

const READ_TOOL = { name: "companion_read_note", description: "读笔记", parameters: {} };
const WEB_TOOL = { name: "agent_web_search", description: "联网", parameters: {} };
const WRITE_TOOL = { name: "companion_edit_note", description: "改笔记", parameters: {} };
const attention = {
  version: 1, requestHash: "abc", intent: "question", toolUse: "uncertain", subjects: [],
  goalRelation: "unrelated", goalReference: null, candidateOperations: [], ambiguities: [], status: "interpreted",
  voiceStyle: { decision: "none" },
} as never;

test("旧轮推理不从历史回放，当前轮的保留", () => {
  const reasoning = [{ type: "reasoning" as const, summary: [], content: [{ type: "reasoning_text" as const, text: "旧念头" }] }];
  const messages = [
    { role: "user" as const, content: "旧问题" },
    { role: "assistant" as const, content: "旧回答", reasoning },
    { role: "user" as const, content: "本轮问题", requestBoundary: true },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "r", name: "companion_notes_read", arguments: {} }], reasoning },
    { role: "tool" as const, toolCallId: "r", content: "{}" },
  ] as Parameters<typeof companionReplayMessages>[0];
  const replayed = companionReplayMessages(messages);
  assert.equal(replayed[1]!.reasoning, undefined, "上一轮的推理不能回放成上下文");
  assert.deepEqual(replayed[3]!.reasoning, reasoning, "本轮工具链的推理保留");
  assert.deepEqual(companionReplayMessages([messages[0]!, messages[1]!]), [messages[0]!, messages[1]!],
    "没有本轮边界时保持原样");
});

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
  const carried = correction.at(-1)!;
  assert.equal(carried.role, "system", "repair keeps host authority");
  assert.equal((carried as { hostObservation?: boolean }).hostObservation, true);
  assert.ok(String(carried.content).includes(currentRequest.content), "the exact observation stays verbatim after the marker");
  assert.match(String(carried.content), /用户没有再说一遍/);
  assert.match(String(correction[0]?.content), /当前宿主观察/);
  assert.doesNotMatch(String(correction[0]?.content), /完整回答当前问题/);
});

test("终答步收起工具时绝不留下空工具面配 required 的那一对", () => {
  const shape = companionStepToolSurface({
    toolDefinitions: [READ_TOOL, WRITE_TOOL] as never[],
    finalAnswerOnly: true, requiresTool: true, toolCallCount: 0,
  });
  assert.deepEqual(shape.tools, []);
  assert.equal(shape.toolChoice, "auto", "tools 空 + required 是 provider 直接 400 的那一对");
});

test("联网开关不再摘掉工具面：web 域同时读文档，执行层按动作拒绝", () => {
  // `companion_web` 一个域里有 search 和 read_document 两个动作。按工具摘表面
  // 会连读文档一起摘掉，所以开关只在执行层按 action 生效（见 judgeCompanionUnavailableTool）。
  const shape = companionStepToolSurface({
    toolDefinitions: [READ_TOOL, WEB_TOOL] as never[],
    finalAnswerOnly: false, requiresTool: false, toolCallCount: 0,
  });
  assert.ok(shape.tools.some(tool => tool.name === "agent_web_search"));
  assert.ok(shape.tools.some(tool => tool.name === "companion_read_note"));
});

test("原句批注与整篇交付各自拿到需要完整交付的那句指引", () => {
  const base = { permissionLevel: "full", toolCount: 3, stepBudget: 8, finalAnswerOnly: false, attentionIntent: "question", offeredToolNames: ["companion_read_note"] };
  const annotation = companionStepPolicyText({ ...base, writingAnnotation: true, completeNoteReply: false });
  assert.match(annotation, /companion_notes_write/);
  assert.match(annotation, /action=annotate/);
  assert.match(annotation, /聊天正文不会保存成解释/);
  assert.ok(!annotation.includes("这轮正文会完整保存为笔记学习内容"));
  const noteReply = companionStepPolicyText({ ...base, writingAnnotation: false, completeNoteReply: true });
  assert.match(noteReply, /用连续最终正文完整交付/);
  assert.ok(!noteReply.includes("action=annotate 独立写入"));
  const plain = companionStepPolicyText({ ...base, writingAnnotation: false, completeNoteReply: false });
  assert.ok(!plain.includes("批注正文") && !plain.includes("分句发言工具"));
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

test("unclassified entry omits invented intent while preserving real voice and execution settings", () => {
  const placeholder = companionDirectInterpretation("a".repeat(64));
  const base = { turnPolicy: "policy", runtimePolicy: "execution", executionGuidance: "decide from current request",
    attention: placeholder, currentUserText: "用计算工具核对", messages: [{ role: "user" as const, content: "用计算工具核对" }],
    tools: [READ_TOOL] as never[], toolChoice: "auto" as const, disableThinking: false, reasoningEffort: "low" as const,
    provider: { id: "p", modelId: "m" } as never, temperature: 0.4 };
  const unclassified = assembleCompanionStepRequest(base);
  assert.doesNotMatch(unclassified.systemPrompt, /current_turn_interpretation_data|"intent":"question"/);
  assert.doesNotMatch(unclassified.systemPrompt, /用计算工具核对/);
  const reminder = unclassified.messages.at(-1);
  assert.equal(reminder?.role, "system");
  assert.match(String(reminder?.content), /用计算工具核对/);
  assert.deepEqual(unclassified.tools, base.tools);
  for (const attention of [
    { ...placeholder, executionConstraints: { timeBasedWakeups: "forbid" as const, sourceQuote: "不要定时提醒" } },
    { ...placeholder, voiceStyle: { ...placeholder.voiceStyle, decision: "apply" as const, instruction: "轻声说" } },
  ]) {
    const configured = assembleCompanionStepRequest({ ...base, attention });
    assert.match(configured.systemPrompt, /current_turn_interpretation_data/);
    assert.match(configured.systemPrompt, attention.executionConstraints ? /不要定时提醒/ : /轻声说/);
  }
});

test("a native current message is not copied as another question; tool evidence keeps a neutral request reminder", () => {
  const userText = "闹钟掉进床缝里了";
  const user = {role:"user" as const,content:userText,requestBoundary:true as const};
  const input = {turnPolicy:"policy",runtimePolicy:"execution",executionGuidance:"guidance",
    attention:companionDirectInterpretation("a".repeat(64)),currentUserText:userText,messages:[user],
    tools:[READ_TOOL] as never[],toolChoice:"auto" as const,disableThinking:false,
    provider:{id:"p",modelId:"m"} as never,temperature:0.4};
  const opening = assembleCompanionStepRequest(input);
  assert.doesNotMatch(opening.systemPrompt,/current_request|闹钟掉进床缝里了/);
  assert.deepEqual(opening.messages,[user]);
  const afterRead = assembleCompanionStepRequest({...input,messages:[user,
    {role:"tool",toolCallId:"read",content:'{"note":"background"}'}]});
  assert.equal(afterRead.systemPrompt, opening.systemPrompt, "工具回执不改写可缓存的指令前缀");
  const note = afterRead.messages.at(-1);
  assert.equal(note?.role, "system");
  assert.equal((note as { hostObservation?: boolean }).hostObservation, true);
  assert.match(String(note?.content), /本轮用户的原话如下/);
  assert.match(String(note?.content), /这一轮新的回执/);
  assert.match(String(note?.content), /闹钟掉进床缝里了/);
  assert.doesNotMatch(String(note?.content), /要回答的用户问题/);
  const followUp = assembleCompanionStepRequest({...input,currentUserText:"把那篇正文读出来。",messages:[
    user,{role:"assistant",content:"上一轮只是说过。"},
    {role:"user",content:"把那篇正文读出来。",requestBoundary:true}]});
  assert.equal(followUp.systemPrompt, opening.systemPrompt, "上一轮对话不改写可缓存的指令前缀");
  const followUpNote = followUp.messages.at(-1);
  assert.equal(followUpNote?.role, "system");
  assert.match(String(followUpNote?.content), /把那篇正文读出来/);
  assert.match(String(followUpNote?.content), /历史回复和上一轮回执只说明过去发生过什么/);
});

test("unclassified runtime policy does not reintroduce a task voice through the placeholder question intent", () => {
  const input = {permissionLevel:"full",toolCount:12,stepBudget:Infinity,finalAnswerOnly:false,
    attentionIntent:"question",attentionStatus:"uncertain",toolCallCount:0,
    offeredToolNames:["companion_notes_write"],writingAnnotation:false,completeNoteReply:false};
  const opening = companionStepPolicyText(input);
  assert.match(opening,/普通陈述先当作分享来接/);
  assert.match(opening,/对方求办法时才给办法/);
  assert.match(opening,/companion_load_tools/);
  assert.doesNotMatch(opening,/先判断本轮问题|最后一条用户问题|逐项回应当前问题|其他内容保持原样|面向用户的正文只交代实际结果/);
  const afterTools = companionStepPolicyText({...input,toolCallCount:1});
  assert.match(afterTools,/outcome_unknown|not_executed|unavailable|blocked/);
  assert.match(afterTools,/实际结果和未完成部分/);
  const host = companionStepPolicyText({...input,requestSource:"host_observation"});
  assert.match(host,/当前任务是处理末尾 hostObservation/);
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


test("read-only tool followups do not acquire the unrelated artifact handoff manual", async () => {
  const input = { permissionLevel: "full", toolCount: 2, stepBudget: Infinity, finalAnswerOnly: false,
    attentionIntent: "question", attentionStatus: "uncertain", toolCallCount: 1,
    offeredToolNames: ["companion_observe", "companion_web"], writingAnnotation: false, completeNoteReply: false };
  const read = companionStepPolicyText(input);
  assert.doesNotMatch(read, /要新建笔记|生成速看|后台专业工具/);
  assert.match(read, /普通答复直接给正文/);
  const write = companionStepPolicyText({ ...input, offeredToolNames: ["companion_notes_write", "companion_goals_write"] });
  assert.match(write, /要新建笔记|后台专业工具/);
  const { companionDirectGuidance } = await import("../turn/companion-entry-mode.ts");
  assert.match(companionDirectGuidance("direct_fast"), /仅检索、计算或读取资料后的回答.*不必调用 companion_finish/);
});
