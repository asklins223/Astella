/**
 * 换人格时哪些项会被覆盖 —— 一条规则，落在纯函数里。
 *
 * ## 为什么要拆出这个模块
 *
 * 此前「选一套预设」是一次**整份替换**：预设自带的 name / tags / speakingStyle /
 * examples / activeness / boundaries 全部盖上去。于是用户点一下卡片，她自己调过的
 * 说话方式、他攒下的口头禅、用户手动改过的开关一起没了，而且没有任何提示——
 * 这正是"配置了却像没生效"的另一种形态。
 *
 * 规则只有一条，不靠语义分组去猜：
 *
 *   **只有来源是 `preset` 的项才被新预设覆盖；`user` 与 `assistant` 的原样留下。**
 *
 * 说"语气是她改的、名字是你起的"是判断，会吵架；说"这几项来源不是 preset"不是判断。
 *
 * ## 名字永远不在可覆盖之列
 *
 * §4.8.4「不擅自改用户指定名字」。她自己也改不了（工具面不给 name），
 * 所以换预设时它只是原样带回，不进 `switchableFields`。
 *
 * ## 历史追不到字段级
 *
 * 版本行是整份 append-only，一次只记一个 author。因此「哪一项是谁写的」只有
 * **当前这一版**查得到，翻历史只能看到整份。这是既有架构的硬限制，不是这里偷懒。
 */

import type {
  CompanionPersonaProfileContent,
  PersonaFieldOrigin,
  PersonaOrigin,
  PetProfileActiveness,
} from "./db-schema/companion-memory.ts";
import type { PetPersonaPreset } from "./pet-persona-presets.ts";

export type { PersonaFieldOrigin, PersonaOrigin } from "./db-schema/companion-memory.ts";

/**
 * 人格每一项的字符容量。
 *
 * 只有这一个地方写这些数字：契约校验、她自己的写入端口、进 prompt 前的净化、
 * 界面上的剩余字数都从这一处取。两处各写一遍的结局一定是某一处先漂——
 * 而漂的那一次表现为"存进去了但屏幕上看不见"或"界面能写、契约拒收"。
 */
export const PERSONA_FIELD_CAPACITY = {
  name: 60,
  personalityTags: 20,
  speakingStyle: 1000,
  example: 200,
  // A self-authored document, with free headings and paragraphs. This is the
  // storage/request budget, not a target length or a persona content template.
  selfDescription: 65_536,
  catchphrase: 30,
} as const;

/** 换预设时能逐项选择「替换 / 保留」的项。名字不在其中（见模块头）。 */
export const SWITCHABLE_FIELDS = [
  "speakingStyle",
  "personalityTags",
  "examples",
  "activeness",
  "boundaries.allowPlayful",
  "boundaries.allowNudgeLearning",
  "boundaries.allowVoiceTags",
  "boundaries.catchphrase",
] as const;

export type SwitchableField = typeof SWITCHABLE_FIELDS[number];

/**
 * 能被**改**的项 = 可覆盖的项 + 名字。
 *
 * 名字在这里、却不在 `SWITCHABLE_FIELDS` 里：你能给她改名，但换人格时它永远保留
 * （§4.8.4）。她自己的那条通路仍然收 `SwitchableField`——改不了名字这条规矩
 * 要在类型上就成立，不能只靠描述文案。
 */
export type PersonaEditableField = SwitchableField | "name" | "selfDescription";

/**
 * 她能自己改的项 = 可覆盖的项 + 自我描述。
 *
 * `selfDescription` 也不在 `SWITCHABLE_FIELDS` 里：预设并没有一份"出厂的自我描述"
 * 可以拿去覆盖，所以换人格时它只是原样带回（见 `applyPersonaSwitch`）。她改它走的是
 * 同一条来源记账，用户在人格页看到的仍然是「她改的」。
 */
export type PersonaAssistantEditableField = SwitchableField | "selfDescription";

export const SWITCHABLE_FIELD_LABEL: Record<SwitchableField, string> = {
  speakingStyle: "说话风格",
  personalityTags: "性格标签",
  examples: "示例回复",
  activeness: "表达分量",
  "boundaries.allowPlayful": "玩笑",
  "boundaries.allowNudgeLearning": "学习提醒",
  "boundaries.allowVoiceTags": "语气标签",
  "boundaries.catchphrase": "口头禅",
};

/** 那一项是谁写的。**没有记录就是 `preset`** —— 旧档案不需要回填。 */
export function personaOriginOf(origin: PersonaFieldOrigin | undefined, field: string): PersonaOrigin {
  if (field.startsWith("boundaries.")) {
    const key = field.slice("boundaries.".length) as keyof NonNullable<PersonaFieldOrigin["boundaries"]>;
    return origin?.boundaries?.[key] ?? "preset";
  }
  // 收窄成扁平索引：`keyof PersonaFieldOrigin` 里混着一个 boundaries 子对象。
  return (origin as Record<string, PersonaOrigin | undefined> | undefined)?.[field] ?? "preset";
}

/** 不是预设写的那几项 —— 换人格时它们会被"保留"（除非用户逐项选择替换）。 */
export function personaCustomFields(origin: PersonaFieldOrigin | undefined): SwitchableField[] {
  return SWITCHABLE_FIELDS.filter((field) => personaOriginOf(origin, field) !== "preset");
}

export interface PersonaSwitchOption {
  readonly field: SwitchableField;
  readonly label: string;
  /** 这一次是谁写的。用户看到的是「你改的」还是「她改的」。 */
  readonly origin: Exclude<PersonaOrigin, "preset">;
  /** 现在的值，换人格后原样留下。 */
  readonly current: string;
  /** 换成新预设之后会变成什么。 */
  readonly next: string;
  /** 两边一样时不必打扰用户。 */
  readonly changes: boolean;
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join("、");
  if (value === null || value === undefined) return "";
  return String(value);
}

type PersonaValueSource = {
  speakingStyle: string;
  personalityTags: string[];
  examples: { text: string }[];
  activeness: PetProfileActiveness;
  boundaries: { allowPlayful?: boolean; allowNudgeLearning?: boolean; allowVoiceTags?: boolean; catchphrase?: string | null };
};

/** 显式 switch 而不是 startsWith 收窄：字面量联合只有 switch 能真正收窄。 */
function fieldValue(source: PersonaValueSource, field: SwitchableField): unknown {
  switch (field) {
    case "speakingStyle": return source.speakingStyle;
    case "personalityTags": return source.personalityTags;
    case "examples": return source.examples.map((example) => example.text);
    case "activeness": return source.activeness;
    case "boundaries.allowPlayful": return source.boundaries.allowPlayful;
    case "boundaries.allowNudgeLearning": return source.boundaries.allowNudgeLearning;
    case "boundaries.allowVoiceTags": return source.boundaries.allowVoiceTags;
    case "boundaries.catchphrase": return source.boundaries.catchphrase;
  }
}

function withFieldOrigin(
  origin: PersonaFieldOrigin | undefined,
  field: string,
  value: PersonaOrigin,
): PersonaFieldOrigin {
  const next: PersonaFieldOrigin = { ...origin };
  if (field.startsWith("boundaries.")) {
    const key = field.slice("boundaries.".length) as keyof NonNullable<PersonaFieldOrigin["boundaries"]>;
    next.boundaries = { ...origin?.boundaries, [key]: value };
  } else {
    (next as Record<string, PersonaOrigin>)[field] = value;
  }
  return next;
}

/**
 * 「点这张预设卡会发生什么」—— 先给用户看清楚，再让他选。
 *
 * 返回的 `options` 只包含**来源不是 preset** 的项：`preset` 来源的项没有可失而复得的
 * 东西，不该出现在选择列表里添乱。`changes` 那一列是给用户判断的辅助信息
 * （保留之后和新的预设其实一样，那这一项就没什么好犹豫的）。
 */
export function planPersonaSwitch(
  current: CompanionPersonaProfileContent,
  preset: PetPersonaPreset,
): { options: PersonaSwitchOption[] } {
  const options: PersonaSwitchOption[] = personaCustomFields(current.fieldOrigin)
    .map((field) => {
      const origin = personaOriginOf(current.fieldOrigin, field);
      if (origin === "preset") return null;
      return {
        field,
        label: SWITCHABLE_FIELD_LABEL[field],
        origin,
        current: asText(fieldValue(current, field)),
        next: asText(fieldValue(preset, field)),
        changes: asText(fieldValue(current, field)) !== asText(fieldValue(preset, field)),
      } satisfies PersonaSwitchOption;
    })
    .filter((option): option is PersonaSwitchOption => option !== null);
  return { options };
}

/**
 * 按用户的选择算出切换后的档案。
 *
 * 每一项走的是同一个判定，不是"用户勾了什么就换什么"：
 *
 *   **取预设的值** = 来源本来就是 `preset`（没有东西可失而复得）**或者** 用户勾了它；
 *   **原样保留**   = 其余情况，来源不变。
 *
 * 这里最容易写错的就是把第二类当成唯一条件——那样"来源是 preset 的项"会永远
 * 赖在旧值上，切三次人格之后她还是第一套的样子，而界面上看不出任何异常。
 * （这族测试就是靠 `切到同一套预设` 那两条把它钉住的。）
 *
 * 另外两条：
 * - `name` 永远原样保留（§4.8.4）。
 * - `presetId` 一定变成新预设：无论保住了几项，"当前预设"是哪一个不能含糊。
 *
 * 保留的那一次**不改来源**，所以下次换人格还会再问一遍——这是有意的：
 * 「保留」是一次决定，不是永久豁免。
 */
export function applyPersonaSwitch(
  current: CompanionPersonaProfileContent,
  preset: PetPersonaPreset,
  overwrite: readonly SwitchableField[] = [],
): CompanionPersonaProfileContent {
  const chosen = new Set(overwrite);
  const takesPresetValue = (field: SwitchableField) =>
    chosen.has(field) || personaOriginOf(current.fieldOrigin, field) === "preset";
  let fieldOrigin: PersonaFieldOrigin = { ...current.fieldOrigin };
  for (const field of SWITCHABLE_FIELDS) {
    if (takesPresetValue(field)) fieldOrigin = withFieldOrigin(fieldOrigin, field, "preset");
  }
  const boundaries = { ...current.boundaries };
  for (const key of ["allowPlayful", "allowNudgeLearning", "allowVoiceTags", "catchphrase"] as const) {
    const field = `boundaries.${key}` as SwitchableField;
    if (!takesPresetValue(field)) continue;
    const value = preset.boundaries[key];
    if (value === undefined) delete boundaries[key];
    else (boundaries as Record<string, unknown>)[key] = value;
  }
  return {
    presetId: preset.presetId,
    name: current.name,
    personalityTags: takesPresetValue("personalityTags") ? preset.personalityTags : current.personalityTags,
    speakingStyle: takesPresetValue("speakingStyle") ? preset.speakingStyle : current.speakingStyle,
    examples: takesPresetValue("examples") ? preset.examples : current.examples,
    activeness: takesPresetValue("activeness") ? preset.activeness : current.activeness,
    // 自我描述没有预设基线可覆盖：换成另一套人格，她攒下的那几句仍然带过去。
    // 这里必须显式带回，因为这一份返回值是**逐项列出**的，漏一列就是静默丢弃。
    ...(current.selfDescription === undefined ? {} : { selfDescription: current.selfDescription }),
    boundaries,
    fieldOrigin,
  };
}

/**
 * 用户手动改一项时的档案 + 来源。
 *
 * 改过的项来源打 `user`（此前是 `assistant` 的项也会变成 `user`——用户接手了，
 * 下一个换人格的提示里就会说「你改的」）。没改的项原样带着走。
 */
export function withUserEditedField<T extends CompanionPersonaProfileContent>(
  profile: T,
  field: PersonaEditableField,
  value: unknown,
): T {
  return { ...applyFieldValue(profile, field, value), fieldOrigin: withFieldOrigin(profile.fieldOrigin, field, "user") } as T;
}

/** 她自己改一项时的档案 + 来源。名字不在可改之列（§4.8.4）。 */
export function withAssistantEditedField<T extends CompanionPersonaProfileContent>(
  profile: T,
  field: PersonaAssistantEditableField,
  value: unknown,
): T {
  return { ...applyFieldValue(profile, field, value), fieldOrigin: withFieldOrigin(profile.fieldOrigin, field, "assistant") } as T;
}

function applyFieldValue<T extends CompanionPersonaProfileContent>(
  profile: T,
  field: PersonaEditableField,
  value: unknown,
): T {
  switch (field) {
    case "name": return { ...profile, name: String(value) };
    case "speakingStyle": return { ...profile, speakingStyle: String(value) };
    case "selfDescription": return { ...profile, selfDescription: String(value) };
    case "personalityTags": return { ...profile, personalityTags: (value as string[]).map(String) };
    case "examples": return { ...profile, examples: (value as { text: string }[]).map((e) => ({ text: String(e.text ?? "") })) };
    case "activeness": return { ...profile, activeness: value as PetProfileActiveness };
    case "boundaries.allowPlayful":
    case "boundaries.allowNudgeLearning":
    case "boundaries.allowVoiceTags":
    case "boundaries.catchphrase": {
      const key = field.slice("boundaries.".length) as keyof NonNullable<CompanionPersonaProfileContent["boundaries"]>;
      return { ...profile, boundaries: { ...profile.boundaries, [key]: value } };
    }
    // 认不出的键：原样返回。落到最后那个"当作 boundaries 的子键"的分支会写出
    // `boundaries[""] = …` 这种东西，然后整份档案在 zod 的 strict 校验上炸掉——
    // 而炸掉的位置离真正的原因隔着一整条链路。
    default: return profile;
  }
}

/** 账号还没有人格档案时，以系统默认人格为底稿起一份 —— 她第一次自己改就能落地。 */
export function personaFromDefaultPreset(preset: PetPersonaPreset): CompanionPersonaProfileContent {
  return {
    presetId: preset.presetId,
    name: preset.name,
    personalityTags: [...preset.personalityTags],
    speakingStyle: preset.speakingStyle,
    examples: preset.examples.map((example) => ({ text: example.text })),
    activeness: preset.activeness,
    boundaries: { ...preset.boundaries },
    // 整套都来自预设，于是换人格时每一项都可覆盖——这正是"刚起手"应有的状态。
    fieldOrigin: {},
  };
}
