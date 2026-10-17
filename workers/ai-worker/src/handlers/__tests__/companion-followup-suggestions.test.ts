/**
 * 追问生成器的行为守卫：它是**可选**增益，任何异常形状都不能变成回复的失败。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { generateCompanionFollowupPrompts } from "../proactive/companion-followup-suggestions.ts";

function providerReturning(result: string | (() => Promise<string>)) {
  const calls: { messages: unknown; options: unknown }[] = [];
  const provider = {
    id: "openai_companion_test",
    modelId: "test-model",
    visionModelId: "test-vision-model",
    promptVersion: "test-v1",
    async chatCompletion(messages: unknown, options: unknown) {
      calls.push({ messages, options });
      const content = typeof result === "string" ? result : await result();
      return { content, usage: {} };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

function generate(content: string | (() => Promise<string>), args: { userText?: string; assistantText?: string } = {}) {
  const { provider, calls } = providerReturning(content);
  return generateCompanionFollowupPrompts({
    provider,
    userText: args.userText ?? "冰为什么比水轻？",
    assistantText: args.assistantText ?? "因为结冰时水分子排成空的六方格子。",
    signal: new AbortController().signal,
  }).then((prompts) => ({ prompts, calls }));
}

test("AI 判断不值得延伸时给空数组，这是正常结果不是失败", async () => {
  const { prompts } = await generate('{"prompts":[]}');
  assert.deepEqual(prompts, []);
});

test("输出不是合法 JSON 或形状不对时收成空数组，不许抛", async () => {
  for (const content of ["", "我不是 JSON", '{"prompts":"nope"}', '{"prompts":[1,2]}', '{"prompts":[],"extra":1}']) {
    const { prompts } = await generate(content);
    assert.deepEqual(prompts, [], content);
  }
});

test("重复和空白差异被去掉，超长/过短的条目被丢弃", async () => {
  const long = "为什么".repeat(50);
  const { prompts } = await generate(JSON.stringify({
    prompts: [
      "水结冰时体积会膨胀吗",
      "  水结冰时体积会膨胀吗  ",
      "好",
      long,
      "湖面结冰后鱼怎么活下来",
    ],
  }));
  assert.deepEqual(prompts, ["水结冰时体积会膨胀吗", "湖面结冰后鱼怎么活下来"]);
});

test("模型多给两条时留下前面三条，不是整批丢掉", async () => {
  const { prompts } = await generate(JSON.stringify({
    prompts: ["第一条追问方向", "第二条追问方向", "第三条追问方向", "第四条追问方向"],
  }));
  assert.deepEqual(prompts, ["第一条追问方向", "第二条追问方向", "第三条追问方向"]);
});

test("对话材料以 JSON 传入并要求 JSON 输出、关思考档", async () => {
  const { calls } = await generate('{"prompts":["冰的密度是多少"]}');
  assert.equal(calls.length, 1);
  const options = calls[0]!.options as Record<string, unknown>;
  assert.equal(options.responseFormat, "json_object");
  assert.equal(options.disableThinking, true);
  const messages = calls[0]!.messages as { role: string; content: string }[];
  const material = JSON.parse(messages[1]!.content) as Record<string, string>;
  assert.equal(material.userMessage, "冰为什么比水轻？");
  assert.equal(material.assistantReply, "因为结冰时水分子排成空的六方格子。");
});

test("超长的一边只留首尾，送出去的材料有界", async () => {
  const { calls } = await generate('{"prompts":[]}', { assistantText: "答".repeat(20_000) });
  const messages = calls[0]!.messages as { role: string; content: string }[];
  const material = JSON.parse(messages[1]!.content) as { assistantReply: string };
  assert.ok(material.assistantReply.length < 20_000);
  assert.match(material.assistantReply, /\[中间内容省略\]/);
});

test("外部模型慢到超过预算时放弃这一批追问", async () => {
  await assert.rejects(generate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    return '{"prompts":["太迟的追问"]}';
  }));
});

test("调用方已经取消时不再等待追问结果", async () => {
  const controller = new AbortController();
  controller.abort();
  const { provider } = providerReturning('{"prompts":["不该等的追问"]}');
  await assert.rejects(generateCompanionFollowupPrompts({
    provider,
    userText: "冰为什么比水轻？",
    assistantText: "因为六方格子。",
    signal: controller.signal,
  }));
});
