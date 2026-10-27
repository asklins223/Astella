import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import { companionActionProgressLabel } from "../agent/companion-action-progress.ts";

type ProgressInput = Pick<AgentTurnInterpretationV1, "toolUse" | "ambiguities"> & {
  readonly candidateOperations: readonly string[];
};

const intent = (overrides: Partial<ProgressInput> = {}): ProgressInput => ({
  toolUse: "act",
  ambiguities: [],
  candidateOperations: ["notes.write.create"],
  ...overrides,
});

test("清楚的新笔记动作先显示不承诺保存结果的整理状态", () => {
  assert.equal(
    companionActionProgressLabel(intent(), ["notes.write.create"]),
    "我先整理笔记内容…",
  );
});

test("明确的笔记编辑显示对应进度", () => {
  assert.equal(
    companionActionProgressLabel(intent({ candidateOperations: ["notes.write.edit"] }), ["notes.write.edit"]),
    "我先检查笔记，再按你说的调整…",
  );
});

test("其他可执行动作使用通用状态", () => {
  assert.equal(
    companionActionProgressLabel(intent({ candidateOperations: ["persona.write.boundary"] }), ["persona.write.boundary"]),
    "我开始处理你刚才交代的事…",
  );
});

test("不确定、存在歧义或当前没有可执行工具时不伪报开始动作", () => {
  assert.equal(companionActionProgressLabel(intent({ toolUse: "uncertain" }), ["notes.write.create"]), null);
  assert.equal(companionActionProgressLabel(intent({ ambiguities: ["笔记对象不明确"] }), ["notes.write.edit"]), null);
  assert.equal(companionActionProgressLabel(intent(), []), null);
});
