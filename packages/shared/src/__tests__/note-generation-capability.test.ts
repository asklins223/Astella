/**
 * 笔记产物槽（`note_generation`）——2026-10-16 线上速看单发 242 s 之后拆出来的那一条链。
 *
 * 路由、档位覆盖、以及"覆盖无效时不下发"这三件事放在同一份测试里，因为它们是同一条
 * 链上的三个环节：任务路由决定用哪个槽 → 槽声明决定下发哪个思考档 → 非法档位必须
 * 被丢弃（上游对不认的档位直接 400）。
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getCapabilityForTask } from "../task-router.ts";
import type { AIPlatformConfig } from "../platform-config.ts";
import { resetPlatformConfigCache, resolveSystemPlatform, setPlatformConfig } from "../platform-config-node.ts";

afterEach(() => resetPlatformConfigCache());

test("笔记产物与伴星对话分开计思考档位，互动演示不跟着降档", () => {
  for (const task of [
    "note_learning_overview",
    "note_learning_mind_map",
    "note_annotation_explain",
    "note_expansion_draft",
  ] as const) {
    assert.equal(getCapabilityForTask(task), "note_generation", `${task} 应与对话模型分开计思考档位`);
  }
  assert.equal(getCapabilityForTask("companion_agent"), "agent_turn");
  // 整页 HTML/SVG 的自主创作有自己的完成判据与预算，不跟着 `low` 走。
  assert.equal(getCapabilityForTask("note_dynamic_artifact"), "agent_turn");
});

function platformConfig(capabilities: AIPlatformConfig["capabilities"]): AIPlatformConfig {
  return {
    platforms: {
      main: {
        type: "mimo_responses",
        apiKey: "test-key",
        baseUrl: "https://example.invalid/v1",
        models: {
          "mimo-v2.6-flash": {
            contextWindowTokens: 1_000_000,
            maxOutputTokens: 131_072,
            reasoning: { levels: ["none", "low", "medium", "high"], default: "medium" },
          },
        },
      },
    },
    capabilities,
  };
}

test("能力级 reasoningEffort 覆盖这条链的下发档位，模型档案的默认档不受影响", () => {
  setPlatformConfig(platformConfig({
    agent_turn: { platform: "main", model: "mimo-v2.6-flash" },
    note_generation: { platform: "main", model: "mimo-v2.6-flash", reasoningEffort: "low" },
  }));

  const note = resolveSystemPlatform("note_generation");
  const agent = resolveSystemPlatform("agent_turn");
  assert.equal(note?.modelProfile?.reasoning?.default, "low", "笔记产物按能力声明下发 low");
  assert.equal(agent?.modelProfile?.reasoning?.default, "medium", "伴星对话仍是模型档案的 medium");
  // 覆盖的是默认档，不是"这个模型能接受哪些档"。
  assert.deepEqual(note?.modelProfile?.reasoning?.levels, ["none", "low", "medium", "high"]);
  // 同一台模型、同一份档案：覆盖不能变成第二份会漂移的模型声明。
  assert.equal(note?.platformId, agent?.platformId);
  assert.equal(note?.model, agent?.model);
  assert.equal(note?.modelProfile?.maxOutputTokens, agent?.modelProfile?.maxOutputTokens);
});

test("覆盖值不在模型声明的档位里时被丢弃，仍按档案默认下发", () => {
  setPlatformConfig(platformConfig({
    // muse-spark 那类不接受 none 的模型真的存在：设成上游不认的值会直接 400。
    note_generation: { platform: "main", model: "mimo-v2.6-flash", reasoningEffort: "xhigh" },
  }));
  assert.equal(resolveSystemPlatform("note_generation")?.modelProfile?.reasoning?.default, "medium");
});

test("模型档案没有声明 reasoning 时覆盖无效，不会被凭空下发", () => {
  const config = platformConfig({
    note_generation: { platform: "main", model: "mimo-v2.6-flash", reasoningEffort: "low" },
  });
  delete config.platforms.main!.models!["mimo-v2.6-flash"]!.reasoning;
  setPlatformConfig(config);
  assert.equal(resolveSystemPlatform("note_generation")?.modelProfile?.reasoning, undefined);
});

test("未映射 note_generation 的旧配置解析为 null，由调用方回落主对话模型", () => {
  setPlatformConfig(platformConfig({
    agent_turn: { platform: "main", model: "mimo-v2.6-flash" },
  }));
  assert.equal(resolveSystemPlatform("note_generation"), null);
  assert.equal(resolveSystemPlatform("agent_turn")?.model, "mimo-v2.6-flash");
});
