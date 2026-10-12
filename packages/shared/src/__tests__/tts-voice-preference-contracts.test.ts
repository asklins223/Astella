// 音色偏好与试听两条合同的用例。
//
// 这两个 schema 是"什么值允许进上游合成接口"的唯一关口：voice 会原样打到阿里百炼
// 的计费接口上，引擎与音色配错时上游只回一句 `[cosyvoice:]Engine error [411]`，
// 不指出是音色问题——所以必须在这里就拒掉，而不是让用户点了之后听三秒沉默。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companionVoicePreferencePatchV1Schema,
  companionVoicePreferenceV1Schema,
} from "../contracts/companion-shell-contracts.ts";

test("写入：引擎与音色配对的组合才收", () => {
  const ok = companionVoicePreferencePatchV1Schema.safeParse({
    version: 1,
    engine: "qwen",
    voice: "longhua_v3.1",
  });
  assert.equal(ok.success, true);
});

test("写入：跨引擎的音色被拒，且报错指到 voice 这一项", () => {
  const bad = companionVoicePreferencePatchV1Schema.safeParse({
    version: 1,
    engine: "edge",
    voice: "longhua_v3.1",
  });
  assert.equal(bad.success, false);
  if (!bad.success) {
    assert.deepEqual(bad.error.issues.map((i) => i.path.join(".")), ["voice"]);
  }
});

test("写入：目录里没有的 voice 一律拒（不接受前端自由填写）", () => {
  for (const voice of ["", "made-up", "longanhuan_v3.0", "LONGHUA_V3.1"]) {
    assert.equal(
      companionVoicePreferencePatchV1Schema.safeParse({ version: 1, engine: "qwen", voice }).success,
      false,
      `${voice} 不该被接受`,
    );
  }
});

test("写入：未知引擎与多余字段都拒", () => {
  assert.equal(
    companionVoicePreferencePatchV1Schema.safeParse({
      version: 1, engine: "sambert", voice: "longhua_v3.1",
    }).success,
    false,
  );
  assert.equal(
    companionVoicePreferencePatchV1Schema.safeParse({
      version: 1, engine: "qwen", voice: "longhua_v3.1", model: "anything",
    }).success,
    false,
    "strict 对象不能放行未声明字段（否则 model 会被静默吞掉）",
  );
});

test("写入：instruction 按上游计数规则卡长（汉字算 2，超 100 单位拒）", () => {
  assert.equal(
    companionVoicePreferencePatchV1Schema.safeParse({
      version: 1, engine: "qwen", voice: "longhua_v3.1", instruction: "用河南话讲，语速稍慢",
    }).success,
    true,
  );
  assert.equal(
    companionVoicePreferencePatchV1Schema.safeParse({
      version: 1, engine: "qwen", voice: "longhua_v3.1", instruction: "温柔".repeat(51),
    }).success,
    false,
    "51 个汉字 = 102 单位，超限必须在这里拦下而不是发给上游",
  );
  assert.equal(
    companionVoicePreferencePatchV1Schema.safeParse({
      version: 1, engine: "qwen", voice: "longhua_v3.1", instruction: null,
    }).success,
    true,
    "null 是清除偏好的表达，要收",
  );
});

test("回执：读侧必须是完整的五件套", () => {
  const parsed = companionVoicePreferenceV1Schema.safeParse({
    version: 1, engine: "qwen", voice: "longhua_v3.1", instruction: null, explicit: false, updatedAt: null,
  });
  assert.equal(parsed.success, true);
  assert.equal(
    companionVoicePreferenceV1Schema.safeParse({
      version: 1, engine: "qwen", voice: "longhua_v3.1", explicit: false,
    }).success,
    false,
    "缺 instruction 的回执会让设置页分不清「没设过风格」和「服务端没这个字段」",
  );
  assert.equal(
    companionVoicePreferenceV1Schema.safeParse({
      version: 1, engine: "qwen", voice: "longhua_v3.1", instruction: null, explicit: false,
    }).success,
    false,
    "缺 updatedAt 的行会让界面分不清「没设过」和「没读到」",
  );
});
