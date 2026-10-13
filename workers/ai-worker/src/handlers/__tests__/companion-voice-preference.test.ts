import assert from "node:assert/strict";
import test from "node:test";
import { mergePersistentDialectPreference } from "../companion-voice-preference.ts";

// 账号那一行 jsonb 里住着别人的偏好：音色/语速描述（tts_instruction）、引擎与音色选择、
// 作答模态。方言只是其中一个键，所以这里的判据是「只动 tts_dialect，别的一概不碰」。
const stored = {
  tts_engine: "qwen",
  tts_voice: "longhua_v3.1",
  tts_instruction: "声音温柔，语速偏慢",
  tts_dialect: "河南话",
};

test("普通单轮与临时切换都不写长期方言，改默认时新方言覆盖旧值", () => {
  assert.deepEqual(mergePersistentDialectPreference(stored, { action: "keep", dialect: null }),
    { explicitPreferences: stored, changed: false });
  const replaced = mergePersistentDialectPreference(stored, { action: "set", dialect: "四川话" });
  assert.equal(replaced.explicitPreferences.tts_dialect, "四川话");
  assert.equal(mergePersistentDialectPreference(stored, { action: "set", dialect: "河南话" }).changed, false,
    "重复保存同一个默认不产生第二次写入");
});

test("清除长期方言只删那一个键，音色与语速描述原样留着", () => {
  const cleared = mergePersistentDialectPreference(stored, { action: "clear", dialect: null });
  assert.equal("tts_dialect" in cleared.explicitPreferences, false);
  assert.equal(cleared.explicitPreferences.tts_instruction, "声音温柔，语速偏慢");
  assert.equal(cleared.explicitPreferences.tts_engine, "qwen");
  assert.equal(cleared.explicitPreferences.tts_voice, "longhua_v3.1");
  assert.equal(mergePersistentDialectPreference({ tts_engine: "qwen" }, { action: "clear", dialect: null }).changed, false,
    "本来就没存过方言时不写空改动");
});

test("set 只认目录里的具体方言，模糊值当场拒绝而不是落库", () => {
  // 合同层已经拦掉目录外的说法；这里仍要挡住"看起来像方言但其实没登记"的值落库。
  assert.throws(() => mergePersistentDialectPreference(stored, { action: "set", dialect: "家乡话" as never }));
  assert.throws(() => mergePersistentDialectPreference(stored, { action: "set", dialect: null }));
});
