import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../mock.ts";

const provider = new MockProvider();
const fixtureMarker = "【mock:diary-roundtrip】";

test("diary round-trip script selects only an offered candidate and its exact source IDs", async () => {
  const candidate = {
    id: "moment-0123456789abcdef0123",
    source_ids: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
    moment: [{ text: `${fixtureMarker}一起核对了利息并入本金的步骤。` }],
  };
  const result = await provider.chatCompletion([
    { role: "system", content: "你先从已核实的共同片段里选择一幕。" },
    { role: "user", content: JSON.stringify({ candidates: [candidate] }) },
  ], { responseFormat: "json_object", maxTokens: 200 });

  assert.deepEqual(JSON.parse(String(result.content)), {
    selected_id: candidate.id,
    reason_summary: "这段把一起核对的过程留了下来。",
    source_ids: candidate.source_ids,
  });
});

test("diary round-trip script returns a valid grounded draft while ordinary mock calls stay generic", async () => {
  const draft = await provider.chatCompletion([
    { role: "system", content: `只输出 JSON。通常只需要正文：\n素材：${fixtureMarker} 一起核对了利息并入本金的步骤。` },
    { role: "user", content: "写今天这篇。" },
  ], { responseFormat: "json_object", maxTokens: 200 });
  const parsedDraft = JSON.parse(String(draft.content)) as { blocks?: Array<{ type?: string; text?: string }> };
  assert.equal(parsedDraft.blocks?.[0]?.type, "text");
  assert.ok(parsedDraft.blocks?.[0]?.text?.length && parsedDraft.blocks[0].text.length >= 24);

  const ordinary = await provider.chatCompletion([
    { role: "system", content: "只输出 JSON。通常只需要正文：" },
    { role: "user", content: "没有测试标记。" },
  ], { responseFormat: "json_object", maxTokens: 200 });
  assert.deepEqual(JSON.parse(String(ordinary.content)), {
    status: "mock",
    message: "Mock chat completion response",
  });
});
