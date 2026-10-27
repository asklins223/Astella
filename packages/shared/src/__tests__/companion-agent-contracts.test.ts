import assert from "node:assert/strict";
import { companionOperationAction, companionOperationArguments, companionOperationDomainTool }
  from "../agent/companion-domain-tools.ts";
import { COMPANION_AUTONOMOUS_TOOLS } from "../companion/companion-autonomy.ts";
import test from "node:test";
import {
  companionToolConfirmationStage,
  canUseCompanionAgentTool,
  COMPANION_PROPOSAL_EXECUTED_TOOLS,
  companionAgentToolEventV1Schema,
  isVisionGatedCompanionTool,
} from "../contracts/companion/companion-agent-contracts.ts";
import {
  COMPANION_AGENT_TOOL_DEFINITIONS,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "../agent/companion-agent-registry.ts";

test("Agent permission levels keep hard confirmation boundaries", () => {
  const read = { name: "synthetic_read", riskClass: "read" as const, requiresConfirmation: false };
  const reversible = { name: "synthetic_reversible", riskClass: "reversible_low" as const, requiresConfirmation: false };
  const dangerous = { name: "synthetic_irreversible", riskClass: "irreversible" as const, requiresConfirmation: false };

  assert.deepEqual(canUseCompanionAgentTool("read_only", read), {
    allowed: true,
    requiresConfirmation: false,
  });
  assert.equal(canUseCompanionAgentTool("read_only", reversible).allowed, true);
  assert.equal(canUseCompanionAgentTool("guided", reversible).requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("guided", { ...reversible, requiresConfirmation: true }).requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("full", dangerous).requiresConfirmation, true);
  // full = 用户预授权（2026-09-19 对齐原设计）：授权档位下不再逐步确认，
  // 只有 irreversible 仍是安全底线。**但这条只对"worker 真能自己执行"的工具成立**——
  // 命令住在提案那条路的六条走下面那条断言，别让 full 档去找一个不存在的执行器。
  assert.equal(canUseCompanionAgentTool("full", reversible).requiresConfirmation, false);
  assert.equal(
    canUseCompanionAgentTool("full", { name: "synthetic_direct", riskClass: "consequential" as const, requiresConfirmation: true })
      .requiresConfirmation,
    true,
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
  assert.equal(COMPANION_PROPOSAL_EXECUTED_TOOLS.size, 0, "退役链路的提案执行工具已清空");

});

test("低权限提供可审阅的写工具；未知档位不提供能力", () => {
  const readOnly = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnly.length > 0);
  assert.ok(readOnly.every(definition => canUseCompanionAgentTool("read_only", definition).allowed));
  assert.ok(
    resolveAllCompanionAgentTools("guided").length === readOnly.length,
    "两档都能准备结果，执行确认由授权门判断",
  );
  assert.deepEqual(
    resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true }).map((definition) => definition.name),
    COMPANION_AGENT_TOOL_DEFINITIONS.map((definition) => definition.name),
    "权限到顶 + 图片可外发 + 联网已开启时，full 档就是模型可见的整个注册表",
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
  // The visual domain stays offered (display/diagram do not leave the device);
  // only the read_image action is refused at execution.
  assert.ok(withoutConsent.includes("companion_visual"));
  assert.ok(withConsent.includes("companion_visual"));
  assert.equal(withConsent.join(","), withoutConsent.join(","),
    "图片外发不再改变工具面，只改变 read_image 这一动作能否执行");
  // read_only + 政策开着：两条过滤线各自独立，谁都不会替谁放宽。
  assert.ok(
    resolveAllCompanionAgentTools("read_only", { visionEnabled: true })
      .every(definition => canUseCompanionAgentTool("read_only", definition).allowed),
  );
  assert.ok(isVisionGatedCompanionTool("visual.read_image"));
  assert.deepEqual(
    COMPANION_AGENT_TOOL_DEFINITIONS.filter((d) => isVisionGatedCompanionTool(d.name))
      .map((d) => d.name).sort(),
    [],
    "受图片外发管的能力档工具是读图及其视觉域；再加受管工具时必须登记进同一张表",
  );
});

test("Tool argument validation rejects unknown and malformed calls", () => {
  assert.equal(validateCompanionAgentToolArguments("missing_tool", {}).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_observe", { action: "context", extra: true }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_pause_learning", { runId: "not-a-uuid" }).success, false);
  const valid = validateCompanionAgentToolArguments("companion_observe", { action: "history", limit: 3 });
  assert.deepEqual(valid, { success: true, data: { action: "history", limit: 3 } });
});

test("Auto-set / auto-fill 工具按权限分级走确认或直执行（2026-09-19 对齐原设计）", () => {
  for (const name of ["companion_memory_write", "companion_persona_write"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition, `${name} 应已注册`);
    assert.equal(definition.riskClass, "reversible_low");
    // Domain tools confirm per action: save/forget/revise/move and persona edits
    // keep the old confirmation gate; full pre-authorizes, read_only prepares.
    const confirmArgs = name === "companion_memory_write" ? { action: "save" } : { action: "activeness", activeness: "quiet" };
    assert.equal(canUseCompanionAgentTool("guided", definition, confirmArgs).requiresConfirmation, true);
    // Activeness is a user preference write: it stays gated in every tier,
    // including full. Memory writes follow the usual full-tier pre-authorization.
    assert.equal(canUseCompanionAgentTool("full", definition, confirmArgs).requiresConfirmation,
      name === "companion_persona_write");
  }

  // 参数校验：kind 枚举与 DB CHECK 同源；content ≤200 字。
  assert.equal(
    validateCompanionAgentToolArguments("companion_memory_write", { action: "save", kind: "preference", content: "喜欢安静地复习" }).success,
    true,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_memory_write", {
      action: "save", kind: "goal",
      content: "复习完数据库索引",
      sourceQuote: "准备期中考试时复习数据库索引，并在 2026-10-15T17:00:00+08:00 前完成",
      appliesWhen: "准备期中考试时",
      validUntil: "2026-10-15T17:00:00+08:00",
    }).success,
    true,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_memory_write", {
      action: "save", kind: "goal",
      content: "下周完成数据库索引复习",
      validUntil: "下周",
    }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_memory_write", {
      action: "save", kind: "goal",
      content: "复习完数据库索引",
      validUntil: "2026-10-15T17:00:00+08:00",
    }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_memory_write", { action: "save", kind: "not_a_kind", content: "x" }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_memory_write", { action: "save", kind: "goal", content: "x".repeat(201) }).success,
    false,
  );
  assert.equal(validateCompanionAgentToolArguments("companion_persona_write", { action: "activeness", activeness: "active" }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_persona_write", { action: "activeness", activeness: "loud" }).success, false);

  const revise = getCompanionAgentTool("companion_memory_write");
  assert.ok(revise, "显式纠正必须能落在记忆写入工具上");
  assert.equal(revise.riskClass, "reversible_low");
  // Confirmation is per action on a merged domain tool.
  assert.equal(canUseCompanionAgentTool("guided", revise, { action: "revise" }).requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("read_only", revise, { action: "revise" }).allowed, true);
  assert.equal(canUseCompanionAgentTool("guided", revise, { action: "revise" }).requiresConfirmation, true);
  // Correcting a stored memory keeps the confirmation gate even at full tier.
  assert.equal(canUseCompanionAgentTool("full", revise, { action: "revise" }).requiresConfirmation, true);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "revise",
    memoryId: "123e4567-e89b-12d3-a456-426614174000",
    expectedRevision: 2,
    content: "周末更适合上午学习",
    appliesWhen: "周末",
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "revise",
    memoryId: "123e4567-e89b-12d3-a456-426614174000",
    expectedRevision: 0,
    content: "周末更适合上午学习",
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "revise",
    memoryId: "123e4567-e89b-12d3-a456-426614174000",
    expectedRevision: 2,
    content: "x".repeat(201),
  }).success, false);

  // 记忆类工具在扁平面上每轮都在——它们曾经挂在 companion-memory 技能下，
  // 关键词没命中就根本不出现在她面前（方案 29 §4.1）。
  const guided = resolveAllCompanionAgentTools("guided").map((definition) => definition.name);
  assert.ok(guided.includes("companion_memory_write"));
  assert.ok(guided.includes("companion_persona_write"));
  assert.ok(guided.includes("companion_memory_read"));
});

test("记忆容量移动是明确请求的可逆写入，并严格校验目标层", () => {
  const recall = getCompanionAgentTool("companion_memory_read");
  const read = getCompanionAgentTool("companion_memory_read");
  const move = getCompanionAgentTool("companion_memory_write");
  assert.ok(recall);
  assert.ok(read);
  assert.ok(move);
  assert.equal(read.riskClass, "read");
  assert.equal(read.requiresConfirmation, false);
  assert.equal(canUseCompanionAgentTool("read_only", read).allowed, true);
  assert.equal(move.riskClass, "reversible_low");
  assert.equal(move.requiresConfirmation, false);
  assert.equal(canUseCompanionAgentTool("read_only", move, { action: "move" }).allowed, true);
  assert.equal(canUseCompanionAgentTool("guided", move, { action: "move" }).allowed, true);
  assert.equal(canUseCompanionAgentTool("full", move, { action: "move" }).requiresConfirmation, false);

  const memoryId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "recall", query: "学习偏好",
    includeShown: true,
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "read", memoryId,
    expectedRevision: 4,
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "read", memoryId,
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "read", memoryId,
    expectedRevision: 0,
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "read", memoryId,
    expectedRevision: 4,
    extra: true,
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "recall", query: "上学期说过的事",
    includeArchived: true,
  }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "recall", query: "上学期说过的事",
    includeArchived: "yes",
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_read", {
    action: "recall", query: "学习偏好",
    includeShown: true,
    extra: true,
  }).success, false);
  for (const tier of ["resident", "active", "archived"]) {
    assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "move", memoryId, tier }).success, true);
  }
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "move", memoryId, tier: "pinned" }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "move", memoryId: "not-a-uuid", tier: "active" }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "move", memoryId, tier: "active", extra: true }).success, false);
  assert.ok(resolveAllCompanionAgentTools("guided").some((definition) => definition.name === "companion_memory_write"));
  assert.ok(resolveAllCompanionAgentTools("read_only").some((definition) => definition.name === "companion_memory_write"));
});

test("Agent SSE event schemas expose only safe tool metadata", () => {
  const tool = getCompanionAgentTool("companion_open");
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
  for (const operation of COMPANION_AUTONOMOUS_TOOLS) {
    const name = companionOperationDomainTool(operation) ?? operation;
    const tool = getCompanionAgentTool(name); assert.ok(tool, name);
    // Autonomous *actions* run without confirmation; the domain tool may also
    // host gated actions (save_participation, cancel_reminder), so pass the
    // specific autonomous action instead of the bare tool.
    for (const permission of ["read_only", "guided", "full"] as const) {
      assert.ok(resolveAllCompanionAgentTools(permission).some(item => item.name === name));
      assert.deepEqual(canUseCompanionAgentTool(permission, tool, { action: operation.split(".").at(-1) }),
        { allowed: true, requiresConfirmation: false }, `${name} ${operation}`);
    }
  }
  for (const [name, args] of [
    ["companion_attention_write", { action: "arrange" }],
    ["companion_attention_write", { action: "schedule_wake" }],
    ["companion_say", { action: "publish" }],
    ["companion_say", { action: "finish_participation" }],
  ] as const) {
    const tool = getCompanionAgentTool(name)!;
    assert.ok(resolveAllCompanionAgentTools("guided").some(item => item.name === name), name);
    assert.deepEqual(canUseCompanionAgentTool("guided", tool, args), { allowed: true, requiresConfirmation: false }, name);
  }
  assert.equal(canUseCompanionAgentTool("read_only", getCompanionAgentTool("companion_notes_write")!, { action: "create" }).allowed, true);
  assert.equal(validateCompanionAgentToolArguments("companion_attention_write", {
    action: "schedule_wake",
    key: "curiosity", expectedRevision: 2, at: "2026-10-11T09:00:00+08:00", reason: "稍后再看看" }).success, true);
});

// ─── 扩展 C（2026-10-15）：mobile 发起的正文修改走 before_execute 确认 ───

test("companionToolConfirmationStage：mobile 发起的 companion_edit_note 一律 before_execute；桌面不变", () => {
  const definition = { riskClass: "reversible_low" as const, name: "notes.write.edit", confirmationStage: undefined as unknown };
  const replaceArgs = { operation: "replace_selection" };
  // 缺省（桌面）：replace 走 after_preview
  assert.equal(companionToolConfirmationStage(definition as never, replaceArgs), "after_preview");
  // mobile：replace 也切成 before_execute（确认后写回）
  assert.equal(
    companionToolConfirmationStage(definition as never, replaceArgs, { originClientKind: "mobile" }),
    "before_execute",
  );
  // 其他工具不受影响
  const other = { riskClass: "reversible_low" as const, name: "notes.read.search", confirmationStage: undefined as unknown };
  assert.equal(
    companionToolConfirmationStage(other as never, {}, { originClientKind: "mobile" }),
    "after_preview",
  );
  // 桌面显式传入也不改变
  assert.equal(
    companionToolConfirmationStage(definition as never, replaceArgs, { originClientKind: "desktop" }),
    "after_preview",
  );
});

test("确认提案冻结的参数能还原成域调用，再校验回同一形状", () => {
  // The ledger keeps operation-scoped fields only; anything that re-validates a
  // frozen card must be able to rebuild the domain call, or confirmation is
  // rejected as stale even though nothing changed.
  for (const [operation, args] of [
    ["memory.write.forget", { memoryId: "11111111-1111-4111-8111-111111111111" }],
    ["persona.write.activeness", { activeness: "quiet" }],
  ] as const) {
    const action = companionOperationAction(operation);
    assert.equal(typeof action, "string", `${operation} 必须能还原出 action`);
    const definition = getCompanionAgentTool(operation);
    assert.ok(definition, `${operation} 必须有声明`);
    const validated = validateCompanionAgentToolArguments(definition!.name, { action, ...args });
    assert.equal(validated.success, true, `${operation} 还原后必须仍然合法`);
    assert.deepEqual(companionOperationArguments(operation, { action, ...args }), args,
      `${operation} 归一化后必须回到提案冻结的那份参数`);
  }
});
