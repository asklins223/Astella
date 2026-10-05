/**
 * 换人格时"什么会被盖掉" —— 这族判据钉的就是那一条规则：
 * **只有来源是 `preset` 的项才被新预设覆盖。**
 *
 * 为什么值得单独钉：这族bug 发生时**没有任何报错**。用户点了卡片，看到
 * "已保存"，而她攒了两周的语气和口头禅没了；模型侧一切正常，测试全绿。
 * 把规则写成纯函数之后才谈得上"钉住"——判据的对象是"这一版档案长什么样"，
 * 不是"文件里写了 preset 这个词"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getPresetById } from "../pet-persona-presets.ts";
import {
  applyPersonaSwitch,
  personaCustomFields,
  personaFromDefaultPreset,
  personaOriginOf,
  planPersonaSwitch,
  withAssistantEditedField,
  withUserEditedField,
  type SwitchableField,
} from "../pet-persona-merge.ts";
import type { CompanionPersonaProfileContent } from "../db-schema/companion-memory.ts";

const FISH = getPresetById("hungry-fish")!;
const WORM = getPresetById("gentle-bookworm")!;

/** 一份"她改过语气、你也改过开关"的档案。 */
function grown(): CompanionPersonaProfileContent {
  return {
    ...personaFromDefaultPreset(FISH),
    speakingStyle: "我刚学会一个省电的摸鱼姿势，讲解也能偷懒。",
    fieldOrigin: { speakingStyle: "assistant", boundaries: { allowNudgeLearning: "user" } },
  };
}

test("她改过的语气换人格时留着 —— 不给提示更不能悄悄清零", () => {
  const next = applyPersonaSwitch(grown(), WORM, []);
  assert.equal(next.speakingStyle, grown().speakingStyle, "默认保留：清零要用户点第二下才会发生");
  assert.equal(next.presetId, "gentle-bookworm", "但当前预设一定换过去");
});

test("用户勾了才覆盖，覆盖之后来源打回 preset（从此归预设管）", () => {
  const next = applyPersonaSwitch(grown(), WORM, ["speakingStyle"]);
  assert.equal(next.speakingStyle, WORM.speakingStyle);
  assert.equal(personaOriginOf(next.fieldOrigin, "speakingStyle"), "preset");
  // 覆盖是一次性的决定，不是永久豁免：来源回到 preset，下次换人格照样会换。
  const again = applyPersonaSwitch(next, FISH, []);
  assert.equal(again.speakingStyle, FISH.speakingStyle);
});

test("保留的那一次，来源不变 —— 下次换人格还会问", () => {
  const kept = applyPersonaSwitch(grown(), WORM, []);
  assert.equal(personaOriginOf(kept.fieldOrigin, "speakingStyle"), "assistant");
  const plan = planPersonaSwitch(kept, FISH);
  assert.ok(plan.options.some((option) => option.field === "speakingStyle"),
    "保留过的项必须再问一次：否则用户会以为它已经变成预设的一部分了");
});

test("名字永远不在可覆盖之列（§4.8.4：她改不了，你也起过）", () => {
  const named = { ...grown(), name: "大肥鱼本鱼" };
  const next = applyPersonaSwitch(named, WORM, ["speakingStyle", "name"] as SwitchableField[]);
  assert.equal(next.name, "大肥鱼本鱼");
  assert.deepEqual(planPersonaSwitch({ ...named, fieldOrigin: { name: "user" } }, WORM).options.map((o) => o.field), [],
    "名字即便来源是 user，也不进选择清单");
});

test("计划里只列非 preset 来源的项，并且写清这一项是谁写的", () => {
  const plan = planPersonaSwitch(grown(), WORM);
  assert.deepEqual(plan.options.map((o) => [o.field, o.origin]).sort(), [
    ["boundaries.allowNudgeLearning", "user"],
    ["speakingStyle", "assistant"],
  ]);
  const style = plan.options.find((o) => o.field === "speakingStyle")!;
  assert.equal(style.label, "说话风格");
  assert.equal(style.current, grown().speakingStyle);
  assert.equal(style.next, WORM.speakingStyle);
  assert.equal(style.changes, true);
});

test("保留之后与新预设其实一样的项，changes 为 false —— 不必拿它烦用户", () => {
  // 三颗开关新预设全是 false，而大肥鱼这边 allowPlayful 开着 → 保留会变。
  const plan = planPersonaSwitch(grown(), WORM);
  const nudge = plan.options.find((o) => o.field === "boundaries.allowNudgeLearning")!;
  assert.equal(nudge.current, "true");
  assert.equal(nudge.next, "false");
  assert.equal(nudge.changes, true);
  // 口头禅两边都是"我去吃饭了" → 勾不勾都一样。
  const catchphrase = withAssistantEditedField(personaFromDefaultPreset(FISH), "boundaries.catchphrase", "我去吃饭了");
  const same = planPersonaSwitch(catchphrase, FISH).options.find((o) => o.field === "boundaries.catchphrase")!;
  assert.equal(same.changes, false);
});

test("没有来源记录的旧档案整套算 preset —— 切换就等于全量覆盖（向后兼容）", () => {
  const legacy: CompanionPersonaProfileContent = {
    presetId: "hungry-fish", name: "大肥鱼", personalityTags: ["贪吃"],
    speakingStyle: "旧版没有来源标记", examples: [], activeness: "active",
    boundaries: { allowPlayful: true },
  };
  assert.deepEqual(personaCustomFields(legacy.fieldOrigin), []);
  assert.deepEqual(planPersonaSwitch(legacy, WORM).options, []);
  const next = applyPersonaSwitch(legacy, WORM, []);
  assert.equal(next.speakingStyle, WORM.speakingStyle, "没有来源＝归预设管");
});

test("用户改的记 user、她改的记 assistant，边界与顶层分开记", () => {
  const mine = withUserEditedField(personaFromDefaultPreset(FISH), "activeness", "quiet");
  assert.equal(personaOriginOf(mine.fieldOrigin, "activeness"), "user");
  assert.equal(mine.activeness, "quiet");
  const hers = withAssistantEditedField(personaFromDefaultPreset(FISH), "boundaries.catchphrase", "开饭了");
  assert.equal(personaOriginOf(hers.fieldOrigin, "boundaries.catchphrase"), "assistant");
  assert.equal(hers.boundaries.catchphrase, "开饭了");
  // 改边界里的一个键，不该把另外三个也标成"她改的"。
  assert.deepEqual(personaCustomFields(hers.fieldOrigin), ["boundaries.catchphrase"]);
});

test("用户接手一项之后，来源从 assistant 变 user", () => {
  const taken = withUserEditedField(grown(), "speakingStyle", "我自己改的");
  assert.equal(personaOriginOf(taken.fieldOrigin, "speakingStyle"), "user");
});

test("从系统默认人格起手的那一份：整套都还归预设管", () => {
  const fresh = personaFromDefaultPreset(FISH);
  assert.equal(fresh.presetId, "hungry-fish");
  assert.equal(fresh.name, FISH.name);
  assert.deepEqual(fresh.examples, FISH.examples);
  assert.deepEqual(fresh.boundaries, FISH.boundaries);
  assert.deepEqual(personaCustomFields(fresh.fieldOrigin), [], "刚起手时换人格不会问任何东西");
});

test("切到同一套预设是幂等的：不会凭空多出一版差异", () => {
  const a = applyPersonaSwitch(grown(), FISH, []);
  const b = applyPersonaSwitch(a, FISH, []);
  assert.deepEqual(a, b);
});
