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
  const { prompts, calls } = await generate('{"prompts":[]}');
  assert.deepEqual(prompts, []);
  assert.ok(Number((calls[0]?.options as { maxTokens?: number }).maxTokens) >= 1_500,
    "追问要给思考留出输出预算，不能把 JSON 挤掉");
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

test("对话材料以 JSON 传入并要求 JSON 输出，思考留给模型默认", async () => {
  const { calls } = await generate('{"prompts":["冰的密度是多少"]}');
  assert.equal(calls.length, 1);
  const options = calls[0]!.options as Record<string, unknown>;
  assert.equal(options.responseFormat, "json_object");
  assert.equal(options.disableThinking, undefined);
  const messages = calls[0]!.messages as { role: string; content: string }[];
  const material = JSON.parse(messages[1]!.content) as { userMessage: string; assistantReply: string; completedWrites: string[] };
  assert.equal(material.userMessage, "冰为什么比水轻？");
  assert.equal(material.assistantReply, "因为结冰时水分子排成空的六方格子。");
  assert.deepEqual(material.completedWrites, []);
  assert.doesNotMatch(messages[0]!.content, /已经记住/);
});

test("写入回执只进本轮材料，规则本身不随回执变化", async () => {
  const plain = providerReturning('{"prompts":[]}');
  const written = providerReturning('{"prompts":[]}');
  const signal = new AbortController().signal;
  await generateCompanionFollowupPrompts({
    provider: plain.provider, userText: "冰为什么比水轻？", assistantText: "因为六方格子。", signal,
  });
  await generateCompanionFollowupPrompts({
    provider: written.provider, userText: "记住雨伞是蓝色的", assistantText: "记住了。",
    completedWrites: ["已经记住：雨伞是蓝色的。"], signal,
  });
  const system = (calls: { messages: unknown }[]) => (calls[0]!.messages as { content: string }[])[0]!.content;
  assert.equal(system(plain.calls), system(written.calls));
  const material = JSON.parse((written.calls[0]!.messages as { content: string }[])[1]!.content) as { completedWrites: string[] };
  assert.deepEqual(material.completedWrites, ["已经记住：雨伞是蓝色的。"]);
});

test("超长的一边只留首尾，送出去的材料有界", async () => {
  const { calls } = await generate('{"prompts":[]}', { assistantText: "答".repeat(20_000) });
  const messages = calls[0]!.messages as { role: string; content: string }[];
  const material = JSON.parse(messages[1]!.content) as { assistantReply: string };
  assert.ok(material.assistantReply.length < 20_000);
  assert.match(material.assistantReply, /\[中间内容省略\]/);
});

test("外部模型慢到超过预算时放弃这一批追问", async () => {
  const { provider } = providerReturning(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return '{"prompts":["太迟的追问"]}';
  });
  await assert.rejects(generateCompanionFollowupPrompts({
    provider,
    userText: "冰为什么比水轻？",
    assistantText: "因为六方格子。",
    signal: new AbortController().signal,
    timeoutMs: 30,
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
