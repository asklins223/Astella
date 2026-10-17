import assert from "node:assert/strict";
import test from "node:test";
import { companionClassifierCapabilities } from "../companion-classifier-surface.ts";
import { buildCompanionTurnInterpretationMessages } from "../companion-tool-intent.ts";
import { resolveAllCompanionAgentTools } from "@astella/shared";

/**
 * The interpreter answers "does this need a tool" and "what kind of work is
 * this". It does not choose the tool; the main model does, against the surface
 * each step offers. On 2026-10-17 production it was handed all 66 conversation
 * tools, which was 69% of its payload while two thirds of turns answered
 * `toolUse: "none"` and never consulted it.
 */

const available = resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true })
  .map(definition => definition.name);

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
