import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionRichBlockLedger, markCompanionWebSearchUnavailable } from "../companion-rich-block-ledger.ts";

const diagram = (title: string) => ({
  type: "diagram" as const,
  title,
  steps: [{ label: "一" }, { label: "二" }],
});

test("同一份内容只记一次，替换后按新列表重新去重", () => {
  const ledger = createCompanionRichBlockLedger([diagram("开场")]);
  const step = diagram("步骤");
  ledger.push(step);
  ledger.push({ ...step, steps: [{ label: "一" }, { label: "二" }] });
  assert.equal(ledger.blocks.length, 2, "内容相同的块只保留一份");

  ledger.replace([diagram("新")]);
  assert.deepEqual(ledger.blocks.map(block => block.type === "diagram" ? block.title : ""), ["新"]);

  ledger.push(diagram("新"));
  assert.equal(ledger.blocks.length, 1, "替换后追加同一份内容仍要去重");
});

test("搜索回执说明服务不可用时，关掉本轮联网工具并记录原因", () => {
  const event: { constraints: { webSearchEnabled?: boolean }; webSearchUnavailableReason?: string } = {
    constraints: { webSearchEnabled: true },
  };
  markCompanionWebSearchUnavailable(event, "quota");
  assert.equal(event.constraints.webSearchEnabled, false);
  assert.equal(event.webSearchUnavailableReason, "quota");

  markCompanionWebSearchUnavailable(event, null);
  assert.equal(event.webSearchUnavailableReason, "service_unavailable");
});
