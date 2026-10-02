/**
 * 「恢复默认」到底重置哪几项（40b §5.2 末段 / A51）。
 *
 * ## 这次钉的是一个已经发生过的回归
 *
 * `resetPetProfile` 之前是 `writeCurrentProfile(..., null, ...)`——**整份置空**。
 * 空的含义是「用当前发布的默认」，于是用户点一次「恢复默认表达」，
 * 连他自己改过的**名字、活跃度、行为边界**一起被抹回预设。
 *
 * 症状是安静的：没有报错、没有红测，只是「名字怎么变回去了」。
 * 合同那句「只恢复声明的表达项，不误清名字、开关或空间记忆」就是为了防这个。
 *
 * 纯函数 `expressionResetProfile` ���被单独导出来，就是为了让上面这张表
 * 每一格都能被断言，而不是靠一次真库集成跑过就算。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PET_PERSONA_PRESETS, getPresetById } from "@ailearn/shared/pet-persona-presets";
import type { CompanionPersonaProfileContent } from "@ailearn/shared/db-schema/companion-memory";

import { expressionResetProfile } from "../pet-profile-service.ts";

const PRESET = PET_PERSONA_PRESETS[0];

/** 一份「用户改过一切」的档案：每一项都与预设不同，恢复默认时才看得出差别。 */
function editedProfile(): CompanionPersonaProfileContent {
  return {
    presetId: PRESET.presetId,
    name: "我给起的小伴",
    personalityTags: ["我加的标签"],
    speakingStyle: "我自己写的一段说话风格",
    examples: [{ text: "我自己加的示范" }],
    activeness: "quiet",
    boundaries: { allowPlayful: false, allowNudgeLearning: false, catchphrase: "口头禅" },
  };
}

test("表达那两项回到当前发布的预设值", () => {
  const next = expressionResetProfile(editedProfile());
  assert.equal(next.speakingStyle, PRESET.speakingStyle, "speakingStyle 没回到预设");
  assert.deepEqual(next.examples, PRESET.examples, "examples 没回到预设");
});

test("名字、开关与所选人格原样保留——这就是 A51 要的那一条", () => {
  const before = editedProfile();
  const next = expressionResetProfile(before);
  assert.equal(next.name, "我给起的小伴", "恢复默认把用户改过的名字也抹了");
  assert.equal(next.activeness, "quiet", "活跃度开关被抹了");
  assert.deepEqual(next.boundaries, before.boundaries, "行为边界开关被抹了");
  assert.equal(next.presetId, before.presetId, "所选人格被换掉了");
  assert.deepEqual(next.personalityTags, before.personalityTags, "性格标签被抹了");
});

test("没有预设可回退时（presetId 失效），只重置成「等于自己」，不整个置空", () => {
  // 置空＝整份回到默认，那会把上面那张表里的「保留」几格也抹掉。
  // 预设查不到时宁可保持原样，也不要顺手把名字换掉。
  const orphan: CompanionPersonaProfileContent = { ...editedProfile(), presetId: "不存在的预设" };
  assert.equal(getPresetById(orphan.presetId), null, "自证样本没造好：这个 presetId 本就该查不到");
  const next = expressionResetProfile(orphan);
  assert.equal(next.name, "我给起的小伴");
  assert.equal(next.speakingStyle, orphan.speakingStyle, "查不到预设时不该凭空换一套说话风格");
  assert.deepEqual(next.examples, orphan.examples);
});

test("【自证】判据认得出「整份置空」这个真实退化", () => {
  // 正控制：把结果整个当成 null（旧行为）时，上面两条断言一定会红。
  const oldBehaviour = { ...editedProfile(), name: "" } as unknown as CompanionPersonaProfileContent;
  assert.notEqual(oldBehaviour.name, "我给起的小伴",
    "自证样本没造好：整份置空之后 name 根本不存在，任何取值都与用户改过的名字不同");
});

test("恢复默认之后，同一份档案再恢复一次是稳定的（幂等）", () => {
  const once = expressionResetProfile(editedProfile());
  const twice = expressionResetProfile(once);
  assert.deepEqual(twice, once, "重复恢复默认不该继续改动任何一项");
});