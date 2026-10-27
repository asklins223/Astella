import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedMainRouteV2Schema } from "../contracts/companion/companion-bridge-contracts.ts";
import {
  COMPANION_AGENT_TOOL_DEFINITIONS,
  COMPANION_AGENT_TOOL_NAMES,
  validateCompanionAgentToolArguments,
} from "../agent/companion-agent-registry.ts";

test("提醒与导航工具的参数边界：时刻只收挂钟，页面只收白名单", () => {
  assert.equal(validateCompanionAgentToolArguments("companion_attention_write", {
    action: "schedule_reminder",
    text: "把疏散路线过一遍",
    fireAtLocal: "2026-09-22 09:00",
  }).success, true);
  // 模型自己换算成 UTC/ISO-Z 一定会差八小时，格式上直接挡住。
  assert.equal(validateCompanionAgentToolArguments("companion_attention_write", {
    action: "schedule_reminder",
    text: "早九点",
    fireAtLocal: "2026-09-22T01:00:00.000Z",
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_open", { target: "page", page: "note_library" }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_open", { target: "page", page: "admin" }).success, false);
  // open_page 不接受任何实体 id：带实体的跳转各有工具做归属校验。
  assert.equal(validateCompanionAgentToolArguments("companion_open", {
    target: "page", page: "note_library",
  }).success, true);
});

test("注册表名字唯一（同名工具会让参数校验表静默覆盖前一个）", () => {
  const seen = new Set<string>();
  const duplicates = COMPANION_AGENT_TOOL_NAMES.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  assert.deepEqual(duplicates, []);
  assert.ok(COMPANION_AGENT_TOOL_NAMES.length >= 20);
});

test("她报得出的页面 = 路由白名单里不需要实体 id 的那一批", () => {
  // 判据从 `allowedMainRouteV2Schema` 现读，不再抄第二份名字清单：
  // 以前枚举手抄成七个，于是「今日」「设置」服务端发得出来、桌面端却没有落点，
  // 而笔记库/理解目标/查找三页她压根叫不出名字，只能被就近塞进来源库和星图。
  const noArgKinds = allowedMainRouteV2Schema.options
    .filter((option) => Object.entries(option.shape)
      .every(([field, schema]) => field === "kind" || schema.isOptional()))
    .map((option) => option.shape.kind.value);
  // 正控制：判据自己得先读到东西。白名单形状变了，这条就要重看一遍。
  assert.equal(noArgKinds.length, 7);
  const definition = COMPANION_AGENT_TOOL_DEFINITIONS
    .find((item) => item.name === "companion_open");
  assert.ok(definition);
  const properties = definition.parameters.properties as { page: { enum: string[] } };
  assert.deepEqual([...properties.page.enum].sort(), [...noArgKinds].sort());
  // safeLabel 的上限是 240，而 `companion-agent-contracts.test.ts` 把整份描述原样当
  // safeLabel 过 schema。词表再加页面就会撞上，这里先把这条约束写在名字里。
  assert.ok(definition.description.length <= 240, `页面描述 ${definition.description.length} 字，超了 safeLabel 上限`);
});

/**
 * **consequential 写工具必须能指名对象**（39b §9.2 / 39d W2-1）。
 *
 * 她改状态的动作如果点名不了对象，服务端就只能"挑一个最近的"——用户看不出为什么改的
 * 是这一项。这不是措辞问题：`companion_plan_route` 的参数曾是 `z.record(z.unknown())`，
 * 31 个工具里**唯一能改状态却零字段校验**的那个。
 *
 * 范围**刻意只收 `consequential`**：`companion_cancel_reminder` 的 `reminderId` 可选是
 * 有意设计（"不给就取消最近那条"），放宽到 `reversible_low` 会把这一类有意项一起误伤。
 */
