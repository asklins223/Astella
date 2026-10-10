/**
 * 「她怎么说自己」这一项的守（方案 50 §8.1）。
 *
 * 这一列是新增的，最容易出的两种错都在**丢内容**上，而且都不会报错：
 *  1. 换人格预设时按缺省把它冲掉（预设里根本没有这一项，覆盖等于清空）；
 *  2. PATCH 是整份写入，界面上改别的项时没把它带回去，于是她攒下的那句话悄悄没了。
 * 两种都只会在用户发现"她怎么突然不记得了"时才暴露，所以钉在这里。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companionPersonaPatchFromContent,
  companionPersonaProfileV1Schema,
} from "../contracts/companion-memory-desktop-contracts.ts";
import {
  PERSONA_FIELD_CAPACITY,
  applyPersonaSwitch,
  personaFromDefaultPreset,
  personaOriginOf,
  withAssistantEditedField,
  withUserEditedField,
} from "../pet-persona-merge.ts";
import { getDefaultPersonaPreset, PET_PERSONA_PRESETS } from "../pet-persona-presets.ts";

const base = personaFromDefaultPreset(getDefaultPersonaPreset());

function withSelfDescription(text: string) {
  return { ...base, selfDescription: text, fieldOrigin: { ...base.fieldOrigin, selfDescription: "assistant" as const } };
}

test("换人格预设不冲掉自我描述：预设里没有这一项，覆盖等于清空", () => {
  const current = withSelfDescription("我讲机制时爱举例，被说过一次正在改。");
  const target = PET_PERSONA_PRESETS.find((preset) => preset.presetId !== current.presetId) ?? PET_PERSONA_PRESETS[1];
  // 用户明确勾了"全部替换"也不给这一项：它没有预设基线可以去换。
  const switched = applyPersonaSwitch(current, target, ["speakingStyle", "personalityTags"]);
  assert.equal(switched.selfDescription, "我讲机制时爱举例，被说过一次正在改。");
  assert.equal(personaOriginOf(switched.fieldOrigin, "selfDescription"), "assistant");
  assert.notEqual(switched.speakingStyle, current.speakingStyle);
});

test("PATCH 拼请求体时把自我描述原样带回；界面上改别的项不会清空它", () => {
  const current = withSelfDescription("我容易一上来就数读过的东西。");
  const request = companionPersonaPatchFromContent(current, 3, { activeness: "quiet" });
  assert.equal(request.selfDescription, "我容易一上来就数读过的东西。");
  assert.equal(request.fieldOrigin?.selfDescription, "assistant");
});

test("用户改这一句时来源转成 user；改成空白是清空，不留一个空的「她写的」", () => {
  const current = withSelfDescription("她原来写的那句。");
  const edited = companionPersonaPatchFromContent(current, 3, { selfDescription: "  我先把话听完。 " });
  assert.equal(edited.selfDescription, "我先把话听完。");
  assert.equal(edited.fieldOrigin?.selfDescription, "user");

  const cleared = companionPersonaPatchFromContent(current, 3, { selfDescription: "   " });
  assert.equal("selfDescription" in cleared, false);
  assert.equal(cleared.fieldOrigin?.selfDescription, undefined);
});

test("她能改这一项，来源记 assistant；名字仍然不在她能改的字段里", () => {
  const edited = withAssistantEditedField(base, "selfDescription", "我讲机制时爱举例。");
  assert.equal(edited.selfDescription, "我讲机制时爱举例。");
  assert.equal(personaOriginOf(edited.fieldOrigin, "selfDescription"), "assistant");
  assert.notEqual(personaOriginOf(edited.fieldOrigin, "name"), "assistant");
  const byUser = withUserEditedField(base, "selfDescription", "用户接手写的一句。");
  assert.equal(personaOriginOf(byUser.fieldOrigin, "selfDescription"), "user");
});

test("容量只有这一个来源：契约按它拒收，超出长度的写入不会静默落库", () => {
  assert.equal(PERSONA_FIELD_CAPACITY.selfDescription, 65_536);
  const tooLong = withSelfDescription("啊".repeat(PERSONA_FIELD_CAPACITY.selfDescription + 1));
  const parsed = companionPersonaProfileV1Schema.safeParse({
    ...tooLong, id: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002",
    revision: 1, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
  });
  assert.equal(parsed.success, false);
});

test("旧档案没有这一项时按原设定读取，不会被当成「空的一句话」或「已经成长过一版」", () => {
  const legacy = {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    presetId: base.presetId, name: base.name, personalityTags: base.personalityTags,
    speakingStyle: base.speakingStyle, examples: base.examples, activeness: base.activeness,
    boundaries: base.boundaries, revision: 2,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const parsed = companionPersonaProfileV1Schema.parse(legacy);
  assert.equal("selfDescription" in parsed, false);
});
