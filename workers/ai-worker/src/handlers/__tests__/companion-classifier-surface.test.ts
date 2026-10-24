import assert from "node:assert/strict";
import test from "node:test";
import { companionClassifierCapabilities } from "../turn/companion-classifier-surface.ts";
import { buildCompanionTurnInterpretationMessages, explicitlyRequestsUtterances } from "../tools/companion-tool-intent.ts";
import { resolveAllCompanionAgentTools, canUseCompanionAgentTool } from "@astella/shared";
import { createCompanionToolSurface, companionAttachmentReadRequired } from "../tools/companion-tool-surface.ts";

/**
 * The interpreter answers "does this need a tool" and "what kind of work is
 * this". It does not choose the tool; the main model does, against the surface
 * each step offers. On 2026-10-17 production it was handed all 66 conversation
 * tools, which was 69% of its payload while two thirds of turns answered
 * `toolUse: "none"` and never consulted it.
 */

const available = resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true })
  .map(definition => definition.name);

test("明确分条消息请求从首步取得发言能力，普通分点回答和否定请求保持自然正文", () => {
  const definitions = resolveAllCompanionAgentTools("full", {});
  for (const text of ["分两条跟我说：第一条问好，第二条问我想做什么。", "可以分几句跟我说，先问好，再问我想学什么。", "请调用 companion_publish_utterance 两次，最后 final=true。", "逐句发给我，先问好。"] ) {
    assert.equal(explicitlyRequestsUtterances(text), true, text);
    const surface = createCompanionToolSurface({ definitions, pageKind: "home", candidateOperations: [], userText: text });
    assert.ok(surface.offered().some(tool => tool.name === "companion_publish_utterance"));
    assert.ok(companionClassifierCapabilities({ availableToolNames: available, pageKind: "home", userText: text }).includes("companion_publish_utterance"));
  }
  for (const text of ["用两句话解释欧姆定律。", "请分点说说。", "不要分两条发给我，只说一句。", "companion_publish_utterance 是什么意思？"]) {
    assert.equal(explicitlyRequestsUtterances(text), false, text);
  }
});

test("普通对话也能从第一步分条发言，安静结束只给主动轮，仍只装配宿主已授权的能力", () => {
  const definitions = resolveAllCompanionAgentTools("full", {});
  const input = { definitions, pageKind: "home", candidateOperations: [] };
  const ordinary = createCompanionToolSurface(input).offered().map(tool => tool.name);
  const initiative = createCompanionToolSurface({ ...input, initiative: true }).offered().map(tool => tool.name);
  assert.ok(ordinary.includes("companion_publish_utterance"), "普通对话里伴星也要能自己决定分条");
  assert.equal(ordinary.includes("companion_finish_participation"), false);
  for (const name of ["companion_publish_utterance", "companion_finish_participation"]) {
    assert.ok(initiative.includes(name), `${name} 不应再等一次装载往返`);
  }
  assert.equal(initiative.includes("companion_create_note"), false);
  const restricted = createCompanionToolSurface({ ...input, initiative: true,
    definitions: definitions.filter(tool => tool.name !== "companion_publish_utterance") });
  assert.equal(restricted.offered().some(tool => tool.name === "companion_publish_utterance"), false);
});

test("明确的新笔记请求在第一次生成前准备授权的笔记能力，空候选不再造成先生成后拒绝", () => {
  for (const text of ["生成几篇历史笔记给我", "写三篇中国历史笔记"]) {
    const definitions = resolveAllCompanionAgentTools("full", {});
    const surface = createCompanionToolSurface({ definitions, pageKind: "home", candidateOperations: [], userText: text });
    assert.ok(surface.offered().some(tool => tool.name === "companion_create_note"));
    assert.ok(companionClassifierCapabilities({ availableToolNames: available, pageKind: "home", userText: text }).includes("companion_create_note"));
  }
  const readOnly = createCompanionToolSurface({ definitions: resolveAllCompanionAgentTools("read_only", {}), pageKind: "home", candidateOperations: [], userText: "生成三篇历史笔记" });
  assert.ok(readOnly.offered().some(tool => tool.name === "companion_create_note"));
  const definition = resolveAllCompanionAgentTools("read_only", {}).find(tool => tool.name === "companion_create_note")!;
  assert.equal(canUseCompanionAgentTool("read_only", definition).requiresConfirmation, true);
});

test("新建笔记时收窄只看真正要做的事：分类器多给或给空，都不再放回无关核心组", () => {
  const definitions = resolveAllCompanionAgentTools("full", {});
  for (const candidateOperations of [[], ["companion_create_note"], ["companion_create_note", "companion_read_context"]] as const) {
    const surface = createCompanionToolSurface({ definitions, pageKind: "home", candidateOperations, userText: "生成三篇中国历史笔记" });
    const offered = surface.offered().map(tool => tool.name);
    assert.ok(offered.includes("companion_create_note"), `候选 ${JSON.stringify(candidateOperations)} 丢了建笔记`);
    assert.equal(offered.includes("companion_save_memory"), false, `候选 ${JSON.stringify(candidateOperations)} 又把记忆写回面里`);
  }
  // 不是新建笔记的话，收窄不该发生：核心组照常给。
  const plain = createCompanionToolSurface({ definitions, pageKind: "home", candidateOperations: [], userText: "今天有点累" });
  assert.ok(plain.offered().some(tool => tool.name === "companion_save_memory"));
});

test("分类器只看这一轮会下发的工具面：核心 + 当前页组 + 装载器", () => {
  const conversation = companionClassifierCapabilities({ availableToolNames: available, pageKind: "today" });
  assert.ok(conversation.length >= 8 && conversation.length <= 24,
    `分类器不该再拿全量目录，实际 ${conversation.length} 个`);
  assert.ok(conversation.includes("companion_read_context"), "核心读取能力要在");
  assert.ok(conversation.includes("companion_load_tools"), "装载器必须始终可见，否则面会关死");
  assert.equal(conversation.includes("companion_switch_task_variant"), false,
    "冷门写工具不该出现在这一页的分类器载荷里");
});

test("分类器看不到的名字仍然可达：候选操作由运行时按目录展开组", () => {
  const today = companionClassifierCapabilities({ availableToolNames: available, pageKind: "today" });
  const full = available.length;
  assert.ok(today.length < full, "这一页的切片必须小于全量目录");
  // 装载器在、页组在 => 分类器即使点名面外工具，运行时仍能按组把它拉进来。
  assert.ok(today.includes("companion_load_tools"));
});

test("载荷实测：切到页组后分类器少付一半字符", () => {
  const messages = [{ role: "user" as const, content: "今天先把最要紧的一件事说清楚：我接下来该先做什么？" }];
  const size = (capabilities: string[]) => {
    const built = buildCompanionTurnInterpretationMessages(messages, {
      objects: [], capabilities, recentMessages: [],
    } as never)!;
    return (built[0].content as string).length + (built[1].content as string).length;
  };
  const full = size(available);
  const sliced = size(companionClassifierCapabilities({ availableToolNames: available, pageKind: "today" }));
  assert.ok(sliced < full * 0.6, `分类器载荷应从 ${full} 降到 60% 以下，实测 ${sliced}`);
});

test("this turn's image attachment exposes vision on a conversation page without classifier guesses", () => {
  const definitions = resolveAllCompanionAgentTools("full", { visionEnabled: true });
  const input = { definitions, pageKind: "conversation", candidateOperations: [], userText: "说说这三张图", hasImageAttachments: true };
  assert.ok(createCompanionToolSurface(input).offered().some(tool => tool.name === "companion_read_image"));
  assert.ok(companionClassifierCapabilities({ availableToolNames: definitions.map(d => d.name), pageKind: "conversation", hasImageAttachments: true }).includes("companion_read_image"));
  const denied = resolveAllCompanionAgentTools("full", { visionEnabled: false });
  assert.ok(!createCompanionToolSurface({ ...input, definitions: denied }).offered().some(tool => tool.name === "companion_read_image"));
});


test("actual attached images need a read receipt even when interpretation is uncertain; explicit opt-out stays honored", () => {
  const input = { hasImageAttachments: true, visionEnabled: true, userText: "请按顺序描述这三张图。" };
  assert.equal(companionAttachmentReadRequired(input), true);
  assert.equal(companionAttachmentReadRequired({ ...input, hasImageAttachments: false }), false);
  assert.equal(companionAttachmentReadRequired({ ...input, visionEnabled: false }), false);
  for (const userText of ["不用看图，先聊聊", "不要帮我分析照片", "don't inspect these images"]) {
    assert.equal(companionAttachmentReadRequired({ ...input, userText }), false);
  }
  assert.equal(companionAttachmentReadRequired({ ...input, userText: "不要猜，看图再回答" }), true);
});
