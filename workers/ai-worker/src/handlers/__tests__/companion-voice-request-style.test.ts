import assert from "node:assert/strict";
import { test } from "node:test";
import { companionVoiceRequestStyle, resolveCompanionVoiceInstruction } from "../companion-voice-request-style.ts";
import { QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION } from "@astella/shared/tts-voice-catalog";

const noStyle = { decision: "none", instruction: null } as const;

test("explicit dialect fallback maps a requested dialect but does not infer a scene", () => {
  assert.equal(companionVoiceRequestStyle("请用河南话讲个笑话"), "请用河南话表达，保持自然语速和清晰吐字");
  assert.equal(companionVoiceRequestStyle("河南话讲个故事"), "请用河南话表达，保持自然语速和清晰吐字");
  assert.equal(companionVoiceRequestStyle("河北话讲个故事"), "请用河北话表达，保持自然语速和清晰吐字");
  assert.equal(companionVoiceRequestStyle("我在研究四川话的声调"), null);
  assert.equal(companionVoiceRequestStyle("我最近听了一个故事，里面提到河南"), null);
});

test("semantic interpreter controls scene and emotional style without topic keyword rules", () => {
  assert.deepEqual(
    resolveCompanionVoiceInstruction("能给我讲个睡前故事吗？", {
      decision: "apply",
      instruction: "声音柔和温暖，语速偏慢，停顿舒缓",
    }),
    { instruction: "声音柔和温暖，语速偏慢，停顿舒缓", source: "semantic" },
  );
});

test("a semantic dialect decision can resolve context even without a dialect keyword in this turn", () => {
  assert.deepEqual(
    resolveCompanionVoiceInstruction("用家乡话给我讲个故事", {
      decision: "apply",
      instruction: "请用河南话表达，语气亲切自然",
    }),
    { instruction: "请用河南话表达，语气亲切自然", source: "semantic" },
  );
});

test("a dialect mention without a speech request remains on the default voice", () => {
  assert.deepEqual(resolveCompanionVoiceInstruction("河南话里的‘中’是什么意思？", noStyle), {
    instruction: null,
    source: "none",
  });
  assert.deepEqual(resolveCompanionVoiceInstruction("我老家在河南，最近有点想家。", noStyle), {
    instruction: null,
    source: "none",
  });
});

test("clarification decision blocks a guessed dialect", () => {
  assert.deepEqual(resolveCompanionVoiceInstruction("讲个方言", { decision: "clarify", instruction: null }), {
    instruction: null,
    source: "clarify",
  });
});

test("missing semantic interpretation uses only the explicit-dialect safety net", () => {
  assert.deepEqual(resolveCompanionVoiceInstruction("河南话讲个故事", null), {
    instruction: "请用河南话表达，保持自然语速和清晰吐字",
    source: "request-fallback",
  });
  assert.deepEqual(resolveCompanionVoiceInstruction("讲个睡前故事", null), {
    instruction: null,
    source: "none",
  });
});

test("账号存的长期方言只跟着陪说话与讲解，文案那一轮回普通话", () => {
  assert.deepEqual(resolveCompanionVoiceInstruction("今天学得怎么样", noStyle, { accountDialect: "河南话" }),
    { instruction: "请用河南话表达", source: "dialect-preference" });
  assert.deepEqual(resolveCompanionVoiceInstruction("把刚才讨论的整理成一篇笔记", noStyle,
    { accountDialect: "河南话", documentWork: true }),
    { instruction: QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION, source: "mandarin-for-document-work" },
    "字要落进笔记的那一轮，口音也跟着回普通话");
  assert.deepEqual(resolveCompanionVoiceInstruction("给我讲讲复数的几何意义", noStyle,
    { accountDialect: "河南话", documentWork: false }),
    { instruction: "请用河南话表达", source: "dialect-preference" }, "讲解概念不算文案工作");
  assert.deepEqual(resolveCompanionVoiceInstruction("用河南话把这条写进笔记",
    { decision: "apply", instruction: "请用河南话表达" },
    { accountDialect: "河南话", documentWork: true }),
    { instruction: "请用河南话表达", source: "semantic" }, "这一句点名要的口音压过文案默认");
});
