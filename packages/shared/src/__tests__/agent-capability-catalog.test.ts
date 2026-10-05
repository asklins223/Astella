import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCapabilityCatalog, getAgentCapability, validateAgentCapabilityArguments } from "../agent-capability-catalog.ts";
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
