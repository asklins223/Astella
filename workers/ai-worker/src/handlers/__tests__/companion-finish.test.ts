import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { companionLatestDeliveryDraft, companionFinishRepeatsPublished, validateCompanionFinish, type CompanionFinishArguments } from "../agent/companion-finish.ts";
import { withCompanionReceiptReferences } from "../tools/companion-tool-receipts.ts";

function writeReceipt(id = "edit-1"): AgentTurnRequest["messages"] {
  return [
    { role: "user", content: "把标题改一下。" },
    { role: "assistant", content: "", toolCalls: [{ id, name: "companion_notes_write", arguments: { action: "edit" } }] },
    { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, receiptId: id, summary: "已保存" }) },
  ];
}

test("quiet completion is explicit, restricted to proactive turns and cannot erase writes or text", () => {
  const quiet = { silent: true, actions: [], evidence: [] };
  assert.deepEqual(validateCompanionFinish(quiet, [], { allowSilent: true }),
    { ok: true, text: "", writesLanded: false });
  assert.equal(validateCompanionFinish(quiet, []).ok, false);
  assert.equal(validateCompanionFinish({ ...quiet, text: "实际内容" }, [], { allowSilent: true }).ok, false);
  assert.equal(validateCompanionFinish(quiet, writeReceipt(), { allowSilent: true }).ok, false);
  assert.equal(validateCompanionFinish({ text: "本轮没有新内容，明天我会提醒你。", actions: [], evidence: [] }, []).ok, true);
});

test("finish accepts only a successful write receipt from this request", () => {
  const result = validateCompanionFinish({ text: "改好了，其他内容没动。", actions: [{ receiptId: "edit-1" }], evidence: [] },
    writeReceipt());
  assert.deepEqual(result, { ok: true, text: "改好了，其他内容没动。", writesLanded: true });
});

test("finish rejects a historical or fabricated write receipt", () => {
  const messages: AgentTurnRequest["messages"] = [
    ...writeReceipt("old-edit"),
    { role: "user", content: "再改一次。" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "read-1", content: JSON.stringify({ ok: true, receiptId: "read-1" }) },
  ];
  const historical = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "old-edit" }], evidence: [] }, messages);
  assert.equal(historical.ok, false);
  assert.match(historical.ok ? "" : historical.error, /本轮真实成功/);

  const readAsAction = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "read-1" }], evidence: [] }, messages);
  assert.equal(readAsAction.ok, false);

  const fabricated = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "made-up" }], evidence: [] }, messages);
  assert.equal(fabricated.ok, false);
});

test("all landed write receipts must be cited regardless of the reply's wording", () => {
  for (const text of ["已经保存好了。", "行。", "下面是一个证明。"])
    assert.equal(validateCompanionFinish({ text, actions: [], evidence: [] }, writeReceipt()).ok, false);
  const result = validateCompanionFinish({ text: "行。", actions: [], evidence: [] }, writeReceipt());
  assert.match(result.ok ? "" : result.error, /尚未全部引用/);
});

test("ordinary prose cannot create an application action or force a retry", () => {
  for (const text of ["你终于搞定了，歇会儿吧。", "这个证法把奇偶引理换成了质因数分解。",
    "故事里的角色说‘我已经保存好了’。"])
    assert.equal(validateCompanionFinish({ text, actions: [], evidence: [] }, [{ role: "user", content: "聊聊" }]).ok, true);
});

test("finish allows a plain read answer with evidence and no actions", () => {
  const messages: AgentTurnRequest["messages"] = [
    { role: "user", content: "这篇笔记说了什么？" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "read-1", content: JSON.stringify({ ok: true, receiptId: "read-1" }) },
  ];
  const result = validateCompanionFinish({ text: "它讲了三件事。", actions: [], evidence: [{ receiptId: "read-1" }] }, messages);
  assert.equal(result.ok, true);
});

test("a deliverable read can be cited as the turn's result, an ordinary read cannot", () => {
  const messages: AgentTurnRequest["messages"] = [
    { role: "user", content: "把我的复习过程画成流程图。" },
    { role: "assistant", content: "", toolCalls: [{ id: "draw-1", name: "companion_visual", arguments: { action: "diagram" } }] },
    { role: "tool", toolCallId: "draw-1",
      content: JSON.stringify({ ok: true, receiptId: "draw-1", summary: "已画出 3 步流程图" }) },
  ];
  // 2026-10-27 live: this exact shape was rejected, costing the turn an extra step.
  const delivered = validateCompanionFinish({ text: "画好了，三步。", actions: [{ receiptId: "draw-1" }], evidence: [] }, messages);
  assert.equal(delivered.ok, true, "a deliverable read is a valid action citation");

  const lookup: AgentTurnRequest["messages"] = [
    { role: "user", content: "这篇笔记说了什么？" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "read-1", content: JSON.stringify({ ok: true, receiptId: "read-1" }) },
  ];
  const asAction = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "read-1" }], evidence: [] }, lookup);
  assert.equal(asAction.ok, false, "an ordinary read cannot stand in for a completed change");
});

test("failed, blocked, pending and unknown outcomes cannot become successful evidence", () => {
  for (const status of ["outcome_unknown", "waiting_confirmation", "failed", "blocked", "not_executed", "unavailable", "pending", "running"]) {
    for (const scope of ["root", "data"]) {
      const messages = writeReceipt();
      messages.at(-1)!.content = JSON.stringify({ ok: true, ...(scope === "root" ? { status } : { data: { status } }) });
      assert.equal(validateCompanionFinish({ text: "已完成", actions: [{ receiptId: "edit-1" }], evidence: [] }, messages).ok, false, scope+status);
    }
  }
});

test("a host initiative is a new receipt scope; a later source observation is not", () => {
  const old = writeReceipt();
  const initiative = [...old, { role: "system" as const, hostObservation: true as const, requestBoundary: true as const, content: "新的观察" }];
  assert.equal(validateCompanionFinish({ text: "完成", actions: [{ receiptId: "edit-1" }], evidence: [] }, initiative).ok, false);
  const observed = [...old, { role: "system" as const, hostObservation: true as const, content: "读取的材料" }];
  assert.equal(validateCompanionFinish({ text: "完成", actions: [{ receiptId: "edit-1" }], evidence: [] }, observed).ok, true);
});

test("one completed goal cannot certify an unfulfilled second goal", () => {
  const finish = { text: "偏好记住了，笔记尚未保存", actions: [{ receiptId: "edit-1" }], evidence: [],
    outcome: "completed" as const, requirements: [
      { requirement: "保存偏好", fulfilled: true, evidenceCallIds: ["edit-1"] },
      { requirement: "保存笔记", fulfilled: false, evidenceCallIds: [] },
    ] };
  const invalid = validateCompanionFinish(finish, writeReceipt(), { requireRequirements: true });
  assert.equal(invalid.ok, false);
  assert.equal(validateCompanionFinish({ ...finish, outcome: "partial" }, writeReceipt(), { requireRequirements: true }).ok, true);
});

test("an unperformed action cannot be marked fulfilled without a real receipt", () => {
  const finish = { text: "已经保存", actions: [], evidence: [], outcome: "completed" as const,
    requirements: [{ requirement: "保存笔记", fulfilled: true, evidenceCallIds: [] }] };
  assert.equal(validateCompanionFinish(finish, [{ role: "user", content: "存起来" }], { requireRequirements: true }).ok, false);
  assert.equal(validateCompanionFinish({ ...finish, requirements: [{ requirement: "解释概念", fulfilled: true, evidenceCallIds: [] }] },
    [{ role: "user", content: "解释概念" }], { requireRequirements: true }).ok, false,
    "没有回执的文字说明不能自称满足要求；普通答复应省略 requirements");
});

test("a late failure for the same call supersedes an earlier optimistic success", () => {
  const messages = [...writeReceipt(), { role: "tool" as const, toolCallId: "edit-1", content: '{"ok":false,"status":"outcome_unknown"}' }];
  assert.equal(validateCompanionFinish({ text: "已保存", actions: [{ receiptId: "edit-1" }], evidence: [] }, messages).ok, false);
});

test("a real read folded out of the prompt remains evidence in the same run", () => {
  const read = [
    { role: "assistant" as const, content: "", toolCalls: [{ id: "read-folded", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool" as const, toolCallId: "read-folded", content: '{"ok":true,"data":{"body":"真实资料"}}' },
  ];
  const messages = [{ role: "user" as const, content: "核对资料" },
    { role: "system" as const, hostObservation: true as const, content: "资料工作摘要" }];
  const input = { text: "根据资料作答", actions: [], evidence: [{ receiptId: "read-folded" }] };
  assert.equal(validateCompanionFinish(input, messages).ok, false, "summary prose cannot fabricate a receipt");
  assert.equal(validateCompanionFinish(input, messages, { currentRunEvidence: read }).ok, true);
});

test("internal repair copies keep successful receipts inside the original request", async () => {
  const { companionStepCorrectionMessages } = await import("../turn/companion-step-plan.ts");
  const request = { role: "user" as const, requestBoundary: true as const, content: "保存这段内容" };
  const messages = [request, ...writeReceipt().slice(1), ...companionStepCorrectionMessages({
    currentRequest: request, instruction: "请引用真实回执交付", alreadyDisplayed: false,
  })];
  assert.equal(messages.filter(message => message.requestBoundary).length, 1);
  assert.equal(validateCompanionFinish({ text: "内容已保存", actions: [{ receiptId: "edit-1" }], evidence: [] }, messages).ok, true);
});

test("delivery repair keeps the unpublished draft as host data and one user request", async () => {
  const { companionDeliveryRepairMessages } = await import("../turn/companion-step-plan.ts");
  const request = { role: "user" as const, requestBoundary: true as const, content: "核对计算" };
  const messages = companionDeliveryRepairMessages({ messages: [request], currentRequest: request,
    result: { content: "计算结果是 10063" }, instruction: "通过交付工具引用计算回执", alreadyDisplayed: false });
  assert.equal(messages.filter(message => message.role === "user").length, 1);
  assert.equal(messages.filter(message => message.requestBoundary).length, 1);
  assert.equal(messages.some(message => message.role === "assistant"), false);
  assert.equal(companionLatestDeliveryDraft(messages), "计算结果是 10063");
});

test("actual independent publications are valid action receipts, including flat-only operations", () => {
  const messages: AgentTurnRequest["messages"] = [{ role: "user", content: "分别发两条" }];
  for (const [id, text] of [["first", "星光"], ["second", "月色"]]) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: "companion_send_message", arguments: { text } }] },
      { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, operation: "say.publish", data: { status: "succeeded" } }) });
  }
  assert.equal(validateCompanionFinish({ text: "已分别发布", outcome: "completed",
    actions: [{ receiptId: "first" }, { receiptId: "second" }], evidence: [],
    requirements: [{ requirement: "两条独立消息", fulfilled: true, evidenceCallIds: ["first", "second"] }],
  }, messages, { requireRequirements: true }).ok, true);
});

test("short receipt references preserve protocol identity and are accepted as exact evidence", () => {
  const raw = writeReceipt("01a182d36133f5d296e39d0baecdc2d0");
  const messages = withCompanionReceiptReferences(raw);
  assert.equal(messages.at(-1)!.toolCallId, raw.at(-1)!.toolCallId);
  assert.equal(JSON.parse(String(messages.at(-1)!.content)).receiptId, "r1");
  assert.deepEqual(withCompanionReceiptReferences(messages), messages, "recovery must not renumber handles");
  const finish = { text: "已保存", outcome: "completed" as const, actions: [{ receiptId: "r1" }], evidence: [],
    requirements: [{ requirement: "保存修改", fulfilled: true, evidenceCallIds: ["r1"] }] };
  assert.equal(validateCompanionFinish(finish, messages, { requireRequirements: true }).ok, true);
  assert.equal(validateCompanionFinish({ ...finish, actions: [{ receiptId: "r2" }] }, messages).ok, false);
  assert.equal(validateCompanionFinish({ ...finish, actions: [{ receiptId: "01a182d36133f5d296e39d0baecdc2d0" }] }, messages).ok, true);
});

test("folding keeps short references stable and allocates a different handle to the next receipt", () => {
  const folded = withCompanionReceiptReferences(writeReceipt("folded")).slice(1);
  const next = withCompanionReceiptReferences(writeReceipt("new-write"), folded);
  assert.equal(JSON.parse(String(next.at(-1)!.content)).receiptId, "r2");
  assert.equal(validateCompanionFinish({ text: "两件已保存", actions: [{ receiptId: "r1" }, { receiptId: "r2" }], evidence: [] },
    next, { currentRunEvidence: folded }).ok, true);
  const newRequest = [...next, { role: "user" as const, content: "新的问题" }];
  assert.equal(validateCompanionFinish({ text: "已保存", actions: [{ receiptId: "r1" }], evidence: [] }, newRequest).ok, false);
});

test("a failed receipt cannot gain success by using its earlier short reference", () => {
  const messages = [...withCompanionReceiptReferences(writeReceipt("write")),
    { role: "tool" as const, toolCallId: "write", content: '{"ok":false,"status":"outcome_unknown"}' }];
  assert.equal(validateCompanionFinish({ text: "已保存", actions: [{ receiptId: "r1" }], evidence: [] }, messages).ok, false);
});

test("ambiguous receipt aliases are rejected instead of guessed", () => {
  const messages = [...withCompanionReceiptReferences(writeReceipt("a")), ...withCompanionReceiptReferences(writeReceipt("b")).slice(1)];
  assert.equal(validateCompanionFinish({ text: "已保存", actions: [{ receiptId: "r1" }], evidence: [] }, messages).ok, false);
  const shadow = [...withCompanionReceiptReferences(writeReceipt("a")), ...writeReceipt("r1").slice(1)];
  assert.equal(validateCompanionFinish({ text: "已保存", actions: [], evidence: [{ receiptId: "r1" }] }, shadow).ok, false);
});


test("finish can deliver the exact current draft without asking the model to rewrite it", () => {
  const draft = "结果为 2/13。\n\n只在给定的检测参数下成立。";
  const messages = [
    { role: "user", content: "旧问题", requestBoundary: true },
    { role: "assistant", content: "不能复用旧答案" },
    { role: "user", content: "这轮问题", requestBoundary: true },
    { role: "assistant", content: draft },
    { role: "system", hostObservation: true, content: "内部交付核对" },
    { role: "user", content: "这轮问题" },
    { role: "assistant", content: "", toolCalls: [{ id: "finish", name: "companion_finish", arguments: {} }] },
  ] as AgentTurnRequest["messages"];
  const result = validateCompanionFinish({ actions: [], evidence: [], outcome: "completed" }, messages);
  assert.deepEqual(result, { ok: true, text: draft, writesLanded: false });
});

test("draft reuse rejects old turns, tool preambles and empty text", () => {
  for (const messages of [
    [{ role: "user", content: "旧问题", requestBoundary: true }, { role: "assistant", content: "旧答案" },
      { role: "user", content: "新的问题", requestBoundary: true }],
    [{ role: "user", content: "当前问题", requestBoundary: true }, { role: "assistant", content: "我去看看", toolCalls: [{ id: "read", name: "lookup", arguments: {} }] }],
    [{ role: "assistant", content: "缺少真实请求边界" }],
  ]) assert.equal(validateCompanionFinish({ actions: [], evidence: [] }, messages as AgentTurnRequest["messages"]).ok, false);
  assert.equal(validateCompanionFinish({ text: "", actions: [], evidence: [] }, []).ok, false);
});

test("正文与唯一finish同次输出时精确保留，避免要求模型重写而重复展示", () => {
  const text="1. DB9D76\n2. B80D2F\n已核对顺序。";
  const messages:AgentTurnRequest["messages"]=[{role:"user",requestBoundary:true,content:"读图"},
    {role:"assistant",content:text,toolCalls:[{id:"finish",name:"companion_finish",arguments:{}}]}];
  assert.deepEqual(validateCompanionFinish({actions:[],evidence:[]},messages),{ok:true,text,writesLanded:false});
  const mixed:AgentTurnRequest["messages"]=[messages[0]!,{...messages[1]!,toolCalls:[
    {id:"read",name:"companion_visual",arguments:{}},{id:"finish",name:"companion_finish",arguments:{}}]}];
  assert.equal(validateCompanionFinish({actions:[],evidence:[]},mixed).ok,false);
});

test("只带语音标签的 finish 正文不算交付", () => {
  const messages: AgentTurnRequest["messages"] = [{ role: "user", requestBoundary: true, content: "读图" }];
  assert.equal(validateCompanionFinish({ text: "[neutral]", actions: [], evidence: [] }, messages).ok, false);
  assert.equal(validateCompanionFinish({ text: "  [neutral]  ", actions: [], evidence: [] }, messages).ok, false);
  assert.equal(validateCompanionFinish({ text: "[neutral] 早上好。", actions: [], evidence: [] }, messages).ok, true);
});

test("finish 只重复本轮已发布的消息时不再追加气泡", () => {
  assert.equal(companionFinishRepeatsPublished("早上好。", ["早上好。"]), true);
  assert.equal(companionFinishRepeatsPublished("[neutral] 早上好。", ["早上好。"]), true);
  assert.equal(companionFinishRepeatsPublished("早上好。\n\n今天准备先做什么？", ["早上好。", "今天准备先做什么？"]), true);
  assert.equal(companionFinishRepeatsPublished("早上好。", ["早上好呀。"]), false);
  assert.equal(companionFinishRepeatsPublished("再补一句。", ["早上好。"]), false);
  assert.equal(companionFinishRepeatsPublished("", ["早上好。"]), false);
});

test("省略 outcome、requirements 与空清单时只交付当前草稿，工作档仍要求目标", () => {
  const text="1. DB9D76\n2. B80D2F";
  const messages:AgentTurnRequest["messages"]=[{role:"user",requestBoundary:true,content:"读图"},
    {role:"assistant",content:text,toolCalls:[{id:"finish",name:"companion_finish",arguments:{}}]}];
  assert.deepEqual(validateCompanionFinish({} as CompanionFinishArguments,messages),{ok:true,text,writesLanded:false});
  assert.equal(validateCompanionFinish({} as CompanionFinishArguments,messages,{requireRequirements:true}).ok,false);
});

/**
 * The delivery contract replaced the wording wordlists: the same sentence must
 * fail without a receipt and pass with one. If this ever breaks, someone has
 * reintroduced phrase matching — that is the regression this guards.
 */
test("the same claim is decided by receipts, not by its wording", () => {
  const claim = "流程图已经画好了，你可以在画板上看到。";
  const requirement = "把复习流程画成流程图";
  const empty = [{ role: "user" as const, content: requirement }];
  const drawn = [
    { role: "user" as const, content: requirement },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "diagram-1", name: "companion_visual", arguments: { action: "diagram" } }] },
    { role: "tool" as const, toolCallId: "diagram-1", content: JSON.stringify({ ok: true, receiptId: "diagram-1" }) },
  ];
  const finish = (evidenceCallIds: string[]) => ({ text: claim, actions: [], evidence: [],
    outcome: "completed" as const, requirements: [{ requirement, fulfilled: true, evidenceCallIds }] });

  assert.equal(validateCompanionFinish(finish(["diagram-1"]), empty, { requireRequirements: true }).ok, false,
    "no receipt for the diagram this turn");
  assert.equal(validateCompanionFinish(finish(["diagram-1"]), drawn, { requireRequirements: true }).ok, true,
    "the same words are fine once the receipt exists");
});
