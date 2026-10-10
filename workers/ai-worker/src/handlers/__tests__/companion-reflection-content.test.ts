/**
 * 反思内容层的守卫单测（方案 50 §9.2 / §15.1）。
 *
 * 这一层最值得单独测的地方在于：**它不需要模型**。
 * "结论有没有依据、能不能写"全是纯规则，能确定性地跑；把这些留在真模型评测里，
 * 就只能知道"这一批样本看起来还行"，而不知道"编造来源的那一条有没有被挡掉"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReflectionPrompt, reflectionInputFingerprint, verifyReflectionOutput,
  type ReflectionInputSnapshotV1,
} from "../companion-reflection-content.ts";

const userOne = "5f0c1a44-0000-4000-8000-000000000001";
const assistantOne = "5f0c1a44-0000-4000-8000-000000000002";
const userTwo = "5f0c1a44-0000-4000-8000-000000000003";
const invented = "5f0c1a44-0000-4000-8000-0000000000ff";

function snapshot(overrides: Partial<ReflectionInputSnapshotV1> = {}): ReflectionInputSnapshotV1 {
  return {
    conversationId: "5f0c1a44-1111-4000-8000-000000000001",
    fromSeq: 0,
    toSeq: 5,
    persona: {
      revision: 3, name: "小猫", speakingStyle: "活泼、爱用语气词",
      selfDescription: "我讲机制时爱举例。", personalityTags: ["好奇"],
    },
    messages: [
      { id: userOne, seq: 1, role: "user", kind: "text", text: "早啊", contentHash: "a".repeat(64) },
      { id: assistantOne, seq: 2, role: "assistant", kind: "text", text: "早！昨天那篇还要接着看吗", contentHash: "b".repeat(64) },
      { id: userTwo, seq: 3, role: "user", kind: "text", text: "以后打招呼别盘点笔记", contentHash: "c".repeat(64) },
    ],
    toolReceipts: [],
    relatedMemories: [],
    ...overrides,
  };
}

const base = { decision: "proposals" as const, summary: "她要求招呼别盘点笔记", judgments: [], experiences: [], persona: null };

test("判断必须引用段内真实存在的用户原话；只有她自己的回复不算依据", () => {
  const judgment = { text: "打招呼时她先把昨天读的东西数了一遍，对方不想要这个。",
    epistemicStatus: "tentative" as const, sourceMessageIds: [assistantOne] };
  const onlyHerself = verifyReflectionOutput({ ...base, judgments: [judgment] }, snapshot());
  assert.equal(onlyHerself.output.judgments.length, 0);
  assert.deepEqual(onlyHerself.rejected, [{ slot: "judgments", index: 0, reason: "missing_user_utterance" }]);

  const cited = verifyReflectionOutput(
    { ...base, judgments: [{ ...judgment, sourceMessageIds: [userTwo, assistantOne] }] }, snapshot());
  assert.equal(cited.output.judgments.length, 1);
  assert.deepEqual(cited.citedSources.map((entry) => entry.kind).sort(), ["assistant_message", "user_message"]);
});

test("引用了一条不存在的消息就整条丢掉，并写下为什么（不截断后照收）", () => {
  const result = verifyReflectionOutput({
    ...base,
    judgments: [{ text: "一条有依据的判断", epistemicStatus: "supported", sourceMessageIds: [userOne] },
      { text: "一条引用了编造 id 的判断", epistemicStatus: "supported", sourceMessageIds: [invented] }],
  }, snapshot());
  assert.deepEqual(result.output.judgments.map((item) => item.text), ["一条有依据的判断"]);
  assert.deepEqual(result.rejected, [{ slot: "judgments", index: 1, reason: "cited_source_not_in_snapshot" }]);
});

test("没有依据的判断直接拒收，不写一条空来源的长期记录", () => {
  const result = verifyReflectionOutput(
    { ...base, judgments: [{ text: "她大概喜欢被打断", epistemicStatus: "tentative", sourceMessageIds: [] }] },
    snapshot());
  assert.equal(result.output.judgments.length, 0);
  assert.deepEqual(result.rejected, [{ slot: "judgments", index: 0, reason: "no_cited_source" }]);
});

test("自我修订与当前生效内容一模一样时不占版本号", () => {
  const result = verifyReflectionOutput({
    ...base,
    persona: { selfDescription: "我讲机制时爱举例。", reason: "沿用同一句", sourceMessageIds: [userTwo] },
  }, snapshot());
  assert.equal(result.output.persona, null);
  assert.equal(result.output.decision, "no_change");
  assert.deepEqual(result.rejected, [{ slot: "persona", index: 0, reason: "unchanged_from_current" }]);
});

test("三项全空时结论是 no_change，这是正常终态而不是失败", () => {
  const result = verifyReflectionOutput({ ...base, summary: "这一句她本来就说得对" }, snapshot());
  assert.equal(result.output.decision, "no_change");
  assert.deepEqual(result.rejected, []);
});

test("方法与判断的同一条来源可以同时用，但同一条消息只记一次依据", () => {
  const result = verifyReflectionOutput({
    ...base,
    judgments: [{ text: "对方不要盘点", epistemicStatus: "tentative", sourceMessageIds: [userTwo] }],
    experiences: [{ title: "打招呼只接眼前这句", triggerCondition: "早上第一句招呼",
      steps: ["先接住这一句"], exceptions: ["对方点名要接着昨天那篇时照常接续"],
      sourceMessageIds: [userTwo] }],
  }, snapshot());
  assert.equal(result.output.experiences.length, 1);
  // 判断与方法都引用了同一条原话：依据只记一次，同一段的重复摘要不算独立佐证。
  assert.deepEqual(result.citedSources, [{ kind: "user_message", id: userTwo }]);
});

test("提示词里带上她当时那一版人格与真实消息 id，并且明确允许什么都不改", () => {
  const prompt = buildReflectionPrompt(snapshot());
  assert.match(prompt, /当前人格第 3 版/);
  assert.match(prompt, /她已有的自我描述：我讲机制时爱举例/);
  assert.match(prompt, new RegExp(userTwo));
  assert.match(prompt, /没有值得留下的就返回/);
  assert.match(prompt, /不能做的/);
});

test("提示词把消息内容里的尖括号之外原样带着，但不带入哈希这类内部字段", () => {
  const prompt = buildReflectionPrompt(snapshot());
  assert.doesNotMatch(prompt, /[0-9a-f]{64}/);
});

test("输入指纹只认消息身份、人格版本与策略版本：重排空白不改变它，换人格版本才改变", () => {
  const first = reflectionInputFingerprint(snapshot(), "reflection-v1");
  const sameContent = reflectionInputFingerprint({
    ...snapshot(),
    messages: snapshot().messages.map((message) => ({ ...message, text: `  ${message.text}  ` })),
  }, "reflection-v1");
  assert.equal(first, sameContent);

  const personaMoved = reflectionInputFingerprint({
    ...snapshot(), persona: { ...snapshot().persona, revision: 4 },
  }, "reflection-v1");
  assert.notEqual(first, personaMoved);

  const strategyBumped = reflectionInputFingerprint(snapshot(), "reflection-v2");
  assert.notEqual(first, strategyBumped);
});
