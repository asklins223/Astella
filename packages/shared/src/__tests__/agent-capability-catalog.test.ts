import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCapabilityCatalog, collectAgentCapabilitySceneGuidance, getAgentCapability,
  validateAgentCapabilityArguments,
} from "../agent-capability-catalog.ts";
import { agentGoalExecutionManifest } from "../agent-capabilities.ts";
import { COMPANION_AGENT_TOOL_DEFINITIONS, getCompanionAgentTool } from "../companion-agent-registry.ts";
import { agentToolParameters } from "../agent-tool-parameters.ts";

test("every surface resolves the same unique capability, validator, model schema and executor metadata", () => {
  assert.ok(agentCapabilityCatalog.length > 35);
  assert.equal(new Set(agentCapabilityCatalog.map(entry => entry.definition.name)).size, agentCapabilityCatalog.length);
  for (const entry of agentCapabilityCatalog) {
    assert.equal(getAgentCapability(entry.definition.name), entry);
    assert.deepEqual(entry.definition.parameters, agentToolParameters(entry.argumentSchema));
    assert.ok(entry.executor && entry.surfaces.length);
    assert.equal(getCompanionAgentTool(entry.definition.name), entry.surfaces.includes("conversation") ? entry.definition : null);
    assert.equal(agentGoalExecutionManifest.some(view => view.definition === entry.definition), entry.surfaces.includes("goal"));
    assert.equal(COMPANION_AGENT_TOOL_DEFINITIONS.includes(entry.definition), entry.surfaces.includes("conversation"));
  }
});
test("unknown capabilities, wrong surfaces and expanded authority fail closed", () => {
  assert.equal(validateAgentCapabilityArguments("invented_action", {}).success, false);
  assert.equal(validateAgentCapabilityArguments("agent_start_goal", {}, "goal").success, false);
  assert.equal(validateAgentCapabilityArguments("agent_calculate", { expression: "12/4" }, "conversation").success, true);
  assert.equal(validateAgentCapabilityArguments("agent_calculate", { expression: "12/4" }, "goal").success, true);
  assert.equal(validateAgentCapabilityArguments("agent_calculate", { expression: "12/4", workspaceId: "another" }).success, false);
});

/**
 * 场景指引的归属（方案 50 §7）。以前「全文编辑的块序号规程」「跳转要不要等点击」
 * 「图片先取真实 id」都写死在**每一步共用**的运行时策略里，于是一次普通招呼的请求
 * 也天天背着它们。现在它们登记在各自的能力上，由这一步真的发下去了哪些工具决定。
 */
test("日常聊天的工具面不带别人的操作规程", () => {
  const chatFace = ["companion_read_context", "companion_search_notes", "companion_read_history"];
  const guidance = collectAgentCapabilitySceneGuidance(chatFace, "guided");
  assert.equal(guidance.some((line) => line.includes("expectedBlocks")), false,
    "面里没有编辑工具时，块序号规程不该进请求");
  assert.equal(guidance.some((line) => line.includes("跳转入口已准备好")), false);
  assert.equal(guidance.some((line) => line.includes("取得真实 id")), false);
});

test("编辑规程只在能编辑的那一步出现一次", () => {
  const face = ["companion_read_note", "companion_edit_note"];
  const guidance = collectAgentCapabilitySceneGuidance(face, "guided");
  assert.equal(guidance.filter((line) => line.includes("expectedBlocks")).length, 1);
});

test("跳转那段按授权档分开，两条导航工具也只说一遍", () => {
  const face = ["companion_open_page", "companion_open_note", "companion_focus_graph"];
  const guided = collectAgentCapabilitySceneGuidance(face, "guided");
  const full = collectAgentCapabilitySceneGuidance(face, "full");
  assert.equal(guided.filter((line) => line.includes("跳转入口已准备好")).length, 1,
    "三条导航能力共用同一段措辞，各说一遍只是占预算");
  assert.equal(guided.some((line) => line.includes("你调用后页面就会切换")), false,
    "guided 档页面没切，说「已经切换」就是假话");
  assert.equal(full.some((line) => line.includes("跳转入口已准备好")), false);
  assert.equal(full.filter((line) => line.includes("你调用后页面就会切换")).length, 1);
  // 两档都要说的那一句不重复。
  assert.equal(guided.filter((line) => line.includes("不要为了接任务自行跳去学习页")).length, 1);
  assert.equal(full.filter((line) => line.includes("不要为了接任务自行跳去学习页")).length, 1);
});

test("每条场景指引都挂在真实存在的能力上，且只在会话面用得到", () => {
  for (const entry of agentCapabilityCatalog) {
    if (!entry.sceneGuidance) continue;
    assert.ok(entry.definition.name, `${entry.definition.name} 的指引必须有登记对象`);
    for (const line of [...entry.sceneGuidance.shared ?? [], ...entry.sceneGuidance.guided ?? [],
      ...entry.sceneGuidance.full ?? []]) {
      assert.ok(line.length > 10, "空的或碎的指引行不该登记");
    }
    // 分开写档位的两段不许写成同一句话，否则分档就没意义。
    if (entry.sceneGuidance.guided && entry.sceneGuidance.full) {
      assert.notDeepEqual(entry.sceneGuidance.guided, entry.sceneGuidance.full);
    }
  }
});
