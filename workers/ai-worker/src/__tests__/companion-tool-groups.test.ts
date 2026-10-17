import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_CORE_TOOL_NAMES,
  COMPANION_TOOL_GROUP_IDS,
  COMPANION_TOOL_GROUPS,
  companionPageToolGroups,
  companionToolGroupCatalog,
  companionToolGroupFor,
  resolveCompanionInitialToolNames,
  resolveCompanionToolGroupNames,
} from "@astella/shared";
import { resolveAllCompanionAgentTools } from "@astella/shared";

const available = resolveAllCompanionAgentTools("full", {
  webSearchEnabled: true,
  visionEnabled: true,
  noteLibraryReadEnabled: true,
}).map(tool => tool.name);

test("每个组引用的工具都在真实目录里，且每个工具最多归属一个组", () => {
  const seen = new Map<string, string>();
  for (const [groupId, group] of Object.entries(COMPANION_TOOL_GROUPS)) {
    for (const tool of group.tools) {
      assert.ok(available.includes(tool), `${groupId} 引用了不存在的工具 ${tool}`);
      assert.equal(seen.get(tool), undefined, `${tool} 同时出现在 ${seen.get(tool)} 与 ${groupId}`);
      seen.set(tool, groupId);
    }
  }
});

test("核心工具都在真实目录里", () => {
  for (const name of COMPANION_CORE_TOOL_NAMES) assert.ok(available.includes(name), name);
});

test("初始工具面 = 核心 + 当前页面组，远小于 65 个", () => {
  const note = resolveCompanionInitialToolNames({ availableToolNames: available, pageKind: "note" });
  assert.ok(note.has("companion_read_note"));
  assert.ok(note.has("companion_load_tools"));
  assert.ok(!note.has("agent_web_search"), "笔记页不默认背联网工具");
  assert.ok(note.size >= 12 && note.size < 30, `笔记页工具数=${note.size}`);
  const home = resolveCompanionInitialToolNames({ availableToolNames: available, pageKind: "today" });
  assert.ok(home.size < note.size, "首页比笔记页更窄");
});

test("候选操作只能加组，不能减掉核心或页面组", () => {
  const base = resolveCompanionInitialToolNames({ availableToolNames: available, pageKind: "note" });
  const expanded = resolveCompanionInitialToolNames({ availableToolNames: available, pageKind: "note",
    candidateOperations: ["agent_web_search", "companion_schedule_reminder"] });
  for (const name of base) assert.ok(expanded.has(name), `${name} 被候选操作挤掉了`);
  assert.ok(expanded.has("agent_web_search"));
  assert.ok(expanded.has("companion_schedule_reminder"));
});

test("装载组解析与页面组声明是同一份", () => {
  assert.deepEqual(resolveCompanionToolGroupNames(["web"]), new Set(COMPANION_TOOL_GROUPS.web.tools));
  assert.deepEqual(resolveCompanionToolGroupNames(["missing-group"]), new Set());
  assert.equal(companionToolGroupFor("companion_read_note"), "notes");
  assert.ok(companionPageToolGroups("note").includes("notes"));
  assert.deepEqual(companionPageToolGroups("unknown-page"), companionPageToolGroups("other"));
});

/**
 * 「装载要不要 notes 才能搜学习卡」这件事，模型只能从装载回执里读。
 * 组用途**不能**放工具描述：那里单条上限 150 字符、总量 4000 且只剩几字符余量
 * （`agent-capability-description-budget.test.ts`），十组说明会直接顶穿。
 * 所以判据盯的是回执：每一组的用途都要到，且取自同一份组声明。
 */
test("装载回执逐组写明用途，取自同一份组声明", () => {
  const catalog = companionToolGroupCatalog(COMPANION_TOOL_GROUP_IDS);
  assert.equal(catalog.length, COMPANION_TOOL_GROUP_IDS.length);
  for (const entry of catalog) {
    const declared = COMPANION_TOOL_GROUPS[entry.id as keyof typeof COMPANION_TOOL_GROUPS];
    assert.equal(entry.label, declared.label, `${entry.id} 的标签与声明不一致`);
    assert.equal(entry.description, declared.description, `${entry.id} 的用途与声明不一致`);
  }
  // 模型传进来的组名按声明顺序去重；不认识的组被丢掉而不是原样回显。
  assert.deepEqual(companionToolGroupCatalog(["web", "notes", "web", "missing"]).map(e => e.id),
    ["web", "notes"]);
});
