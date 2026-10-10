import assert from "node:assert/strict";
import { COMPANION_AUTONOMOUS_TOOLS, isCompanionAutonomousTool } from "../companion-autonomy.ts";
import test from "node:test";
import {
  canUseCompanionAgentTool,
  COMPANION_PROPOSAL_EXECUTED_TOOLS,
  companionAgentToolEventV1Schema,
  isVisionGatedCompanionTool,
} from "../contracts/companion-agent-contracts.ts";
import {
  COMPANION_AGENT_TOOL_DEFINITIONS,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "../companion-agent-registry.ts";

test("Agent permission levels keep hard confirmation boundaries", () => {
  const read = { name: "synthetic_read", riskClass: "read" as const, requiresConfirmation: false };
  const reversible = { name: "synthetic_reversible", riskClass: "reversible_low" as const, requiresConfirmation: false };
  const dangerous = { name: "synthetic_irreversible", riskClass: "irreversible" as const, requiresConfirmation: false };

  assert.deepEqual(canUseCompanionAgentTool("read_only", read), {
    allowed: true,
    requiresConfirmation: false,
  });
  assert.equal(canUseCompanionAgentTool("read_only", reversible).allowed, false);
  assert.equal(canUseCompanionAgentTool("guided", reversible).requiresConfirmation, false);
  assert.equal(canUseCompanionAgentTool("guided", { ...reversible, requiresConfirmation: true }).requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("full", dangerous).requiresConfirmation, true);
  // full = 用户预授权（2026-09-19 对齐原设计）：授权档位下不再逐步确认，
  // 只有 irreversible 仍是安全底线。**但这条只对"worker 真能自己执行"的工具成立**——
  // 命令住在提案那条路的六条走下面那条断言，别让 full 档去找一个不存在的执行器。
  assert.equal(canUseCompanionAgentTool("full", reversible).requiresConfirmation, false);
  assert.equal(
    canUseCompanionAgentTool("full", { name: "synthetic_direct", riskClass: "consequential" as const, requiresConfirmation: true })
      .requiresConfirmation,
    false,
  );

  // 六条提案执行的工具：三档都要出提案（full 档曾经判成"直执行"，于是撞 no direct
  // executor——权限越高越不能用，这条就是钉住那个反差不再回来）。
  for (const name of COMPANION_PROPOSAL_EXECUTED_TOOLS) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition, `${name} 必须在 registry 里`);
    assert.equal(
      canUseCompanionAgentTool("full", definition).requiresConfirmation,
      true,
      `${name} 的命令在提案确认那条路执行，full 档不许改判成直执行`,
    );
    assert.equal(canUseCompanionAgentTool("guided", definition).requiresConfirmation, true, name);
  }
  // 正控制：这份清单不是空集（空集时上面那个循环"全绿"等于什么都没判）。
  assert.ok(COMPANION_PROPOSAL_EXECUTED_TOOLS.size >= 6, `清单只剩 ${COMPANION_PROPOSAL_EXECUTED_TOOLS.size} 条`);

  const focusGraph = getCompanionAgentTool("companion_focus_graph");
  assert.ok(focusGraph);
  assert.equal(canUseCompanionAgentTool("guided", focusGraph).requiresConfirmation, false);
});

test("扁平工具面 fail closed：read_only 保留自主记录并禁止业务写入，未知档位不会放开写工具", () => {
  const readOnly = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnly.length > 0);
  assert.ok(readOnly.every((definition) => definition.riskClass === "read" || isCompanionAutonomousTool(definition.name)));
  assert.ok(
    resolveAllCompanionAgentTools("guided").length > readOnly.length,
    "guided 必须比 read_only 多出写工具",
  );
  assert.deepEqual(
    resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true }).map((definition) => definition.name),
    COMPANION_AGENT_TOOL_DEFINITIONS.map((definition) => definition.name),
    "权限到顶 + 图片可外发 + 联网已开启时，full 档就是整个注册表",
  );
  assert.ok(
    !resolveAllCompanionAgentTools("full").map((d) => d.name).includes("companion_read_image"),
    "权限档位管的是「她能改什么」，不该顺手把图片送出门——政策没开时 full 也拿不到读图工具",
  );
});

test("图片外发政策管的是「看不看得见」，不是「调不调得动」", () => {
  // 政策关着时工具**从工具面里消失**。这是抱怨 #9（"我看看这张图"然后什么都没有）
  // 的根治点：看不见的工具不会被答应，也就没有一句做不到的话落进历史。
  const withoutConsent = resolveAllCompanionAgentTools("full").map((d) => d.name);
  const withConsent = resolveAllCompanionAgentTools("full", { visionEnabled: true }).map((d) => d.name);
  assert.ok(!withoutConsent.includes("companion_read_image"));
  assert.ok(withConsent.includes("companion_read_image"));
  assert.equal(
    withConsent.filter((name) => name !== "companion_read_image").join(","),
    withoutConsent.join(","),
    "开图片外发只多出读图这一个工具，其余工具面不得跟着抖",
  );
  // read_only + 政策开着：两条过滤线各自独立，谁都不会替谁放宽。
  assert.ok(
    resolveAllCompanionAgentTools("read_only", { visionEnabled: true })
      .every((definition) => definition.riskClass === "read" || isCompanionAutonomousTool(definition.name)),
  );
  assert.deepEqual(
    COMPANION_AGENT_TOOL_DEFINITIONS.filter((d) => isVisionGatedCompanionTool(d.name))
      .map((d) => d.name),
    ["companion_read_image"],
    "受图片外发管的能力档工具就这一个；再加受管工具时必须登记进同一张表",
  );
});

test("Tool argument validation rejects unknown and malformed calls", () => {
  assert.equal(validateCompanionAgentToolArguments("missing_tool", {}).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_read_context", { extra: true }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_pause_learning", { runId: "not-a-uuid" }).success, false);
  const valid = validateCompanionAgentToolArguments("companion_read_history", { limit: 3 });
  assert.deepEqual(valid, { success: true, data: { limit: 3 } });
});

test("Auto-set / auto-fill 工具按权限分级走确认或直执行（2026-09-19 对齐原设计）", () => {
  for (const name of ["companion_save_memory", "companion_set_activeness"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition, `${name} 应已注册`);
    assert.equal(definition.riskClass, "reversible_low");
    // 注册表声明需要确认 → guided 档走提案；full 档预授权直执行；
    // read_only 档被门禁阻止。
    assert.equal(definition.requiresConfirmation, true);
    assert.equal(canUseCompanionAgentTool("read_only", definition).allowed, false);
    assert.equal(canUseCompanionAgentTool("guided", definition).requiresConfirmation, true);
    assert.equal(canUseCompanionAgentTool("full", definition).requiresConfirmation, false);
  }

  // 参数校验：kind 枚举与 DB CHECK 同源；content ≤200 字。
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", { kind: "preference", content: "喜欢安静地复习" }).success,
    true,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", {
      kind: "goal",
      content: "复习完数据库索引",
      sourceQuote: "准备期中考试时复习数据库索引，并在 2026-10-15T17:00:00+08:00 前完成",
      appliesWhen: "准备期中考试时",
      validUntil: "2026-10-15T17:00:00+08:00",
    }).success,
    true,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", {
      kind: "goal",
      content: "下周完成数据库索引复习",
      validUntil: "下周",
    }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", {
      kind: "goal",
      content: "复习完数据库索引",
      validUntil: "2026-10-15T17:00:00+08:00",
    }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", { kind: "not_a_kind", content: "x" }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", { kind: "goal", content: "x".repeat(201) }).success,
    false,
  );
  assert.equal(validateCompanionAgentToolArguments("companion_set_activeness", { activeness: "active" }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_set_activeness", { activeness: "loud" }).success, false);

  const revise = getCompanionAgentTool("companion_revise_memory");
  assert.ok(revise, "显式纠正必须有独立的修订工具");
  assert.equal(revise.riskClass, "reversible_low");
  assert.equal(revise.requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("read_only", revise).allowed, false);
  assert.equal(canUseCompanionAgentTool("guided", revise).requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("full", revise).requiresConfirmation, false);
  assert.equal(validateCompanionAgentToolArguments("companion_revise_memory", {
    memoryId: "123e4567-e89b-12d3-a456-426614174000",
    expectedRevision: 2,
    content: "周末更适合上午学习",
    appliesWhen: "周末",
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_revise_memory", {
    memoryId: "123e4567-e89b-12d3-a456-426614174000",
    expectedRevision: 0,
    content: "周末更适合上午学习",
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_revise_memory", {
    memoryId: "123e4567-e89b-12d3-a456-426614174000",
    expectedRevision: 2,
    content: "x".repeat(201),
  }).success, false);

  // 记忆类工具在扁平面上每轮都在——它们曾经挂在 companion-memory 技能下，
  // 关键词没命中就根本不出现在她面前（方案 29 §4.1）。
  const guided = resolveAllCompanionAgentTools("guided").map((definition) => definition.name);
  assert.ok(guided.includes("companion_save_memory"));
  assert.ok(guided.includes("companion_revise_memory"));
  assert.ok(guided.includes("companion_set_activeness"));
  assert.ok(guided.includes("companion_read_memory"));
});

test("记忆容量移动是明确请求的可逆写入，并严格校验目标层", () => {
  const recall = getCompanionAgentTool("companion_recall_memory");
  const read = getCompanionAgentTool("companion_read_memory");
  const move = getCompanionAgentTool("companion_move_memory");
  assert.ok(recall);
  assert.ok(read);
  assert.ok(move);
  assert.equal(read.riskClass, "read");
  assert.equal(read.requiresConfirmation, false);
  assert.equal(canUseCompanionAgentTool("read_only", read).allowed, true);
  assert.equal(move.riskClass, "reversible_low");
  assert.equal(move.requiresConfirmation, false);
  assert.equal(canUseCompanionAgentTool("read_only", move).allowed, false);
  assert.equal(canUseCompanionAgentTool("guided", move).allowed, true);
  assert.equal(canUseCompanionAgentTool("full", move).requiresConfirmation, false);

  const memoryId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(validateCompanionAgentToolArguments("companion_recall_memory", {
    query: "学习偏好",
    includeShown: true,
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_read_memory", {
    memoryId,
    expectedRevision: 4,
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_read_memory", {
    memoryId,
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_read_memory", {
    memoryId,
    expectedRevision: 0,
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_read_memory", {
    memoryId,
    expectedRevision: 4,
    extra: true,
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_recall_memory", {
    query: "上学期说过的事",
    includeArchived: true,
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_recall_memory", {
    query: "上学期说过的事",
    includeArchived: "yes",
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_recall_memory", {
    query: "学习偏好",
    includeShown: true,
    extra: true,
  }).success, false);
  for (const tier of ["resident", "active", "archived"]) {
    assert.equal(validateCompanionAgentToolArguments("companion_move_memory", { memoryId, tier }).success, true);
  }
  assert.equal(validateCompanionAgentToolArguments("companion_move_memory", { memoryId, tier: "pinned" }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_move_memory", { memoryId: "not-a-uuid", tier: "active" }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_move_memory", { memoryId, tier: "active", extra: true }).success, false);
  assert.ok(resolveAllCompanionAgentTools("guided").some((definition) => definition.name === "companion_move_memory"));
  assert.ok(!resolveAllCompanionAgentTools("read_only").some((definition) => definition.name === "companion_move_memory"));
});

test("Agent SSE event schemas expose only safe tool metadata", () => {
  const tool = getCompanionAgentTool("companion_open_page");
  assert.ok(tool);
  assert.equal(companionAgentToolEventV1Schema.safeParse({
    toolCallId: "call-1",
    name: tool.name,
    toolVersion: tool.toolVersion,
    riskClass: tool.riskClass,
    status: "succeeded",
    safeLabel: tool.description,
    route: { kind: "review" },
  }).success, true);
  assert.equal(companionAgentToolEventV1Schema.safeParse({
    toolCallId: "call-unknown-outcome",
    name: tool.name,
    toolVersion: tool.toolVersion,
    riskClass: tool.riskClass,
    status: "outcome_unknown",
    safeLabel: tool.description,
    safeSummary: "操作可能已发生，当前没有确定回执。",
  }).success, true);
  // `agent.skill` 这个 SSE 事件类型已随技能层删除：现在每轮工具面是固定的
  // （只按权限档过滤），"选中了哪个技能"再也不是一个需要广播的事实。
});


test("身份和自己的记事在三档均自主执行；权限开关仍控制业务操作", () => {
  for (const name of COMPANION_AUTONOMOUS_TOOLS) {
    const tool = getCompanionAgentTool(name); assert.ok(tool, name);
    for (const permission of ["read_only", "guided", "full"] as const) {
      assert.ok(resolveAllCompanionAgentTools(permission).some(item => item.name === name));
      assert.deepEqual(canUseCompanionAgentTool(permission, tool), { allowed: true, requiresConfirmation: false });
    }
  }
  assert.equal(canUseCompanionAgentTool("read_only", getCompanionAgentTool("companion_create_note")!).allowed, false);
  assert.equal(validateCompanionAgentToolArguments("companion_schedule_wake", {
    key: "curiosity", expectedRevision: 2, at: "2026-10-11T09:00:00+08:00", reason: "稍后再看看" }).success, true);
});
