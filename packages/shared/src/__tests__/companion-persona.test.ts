import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  COMPANION_CHARACTER_BASE_V5,
  COMPANION_CHARACTER_BASE_V6,
  COMPANION_HOST_PROTOCOL_V5,
  COMPANION_HOST_PROTOCOL_V6,
  COMPANION_IDENTITY_BOUNDARY_V1,
  COMPANION_IDENTITY_BOUNDARY_V2,
  COMPANION_IDENTITY_BOUNDARY_V4,
  COMPANION_PERSONA_V5,
  COMPANION_PERSONA_V5_PROMPT_ID,
  COMPANION_PERSONA_V5_SHA256,
  COMPANION_PERSONA_V6,
  COMPANION_PERSONA_V6_PROMPT_ID,
  COMPANION_PERSONA_V6_SHA256,
  COMPANION_CHARACTER_BASE_V7,
  COMPANION_PERSONA_V7,
  COMPANION_PERSONA_V7_PROMPT_ID,
  COMPANION_PERSONA_V7_SHA256,
  COMPANION_CHARACTER_BASE_V8,
  COMPANION_CHARACTER_BASE_V9,
  COMPANION_PERSONA_V9,
  COMPANION_PERSONA_V9_PROMPT_ID,
  COMPANION_PERSONA_V9_SHA256,
  COMPANION_CHARACTER_BASE_V10,
  COMPANION_PERSONA_V10,
  COMPANION_PERSONA_V10_PROMPT_ID,
  COMPANION_PERSONA_V10_SHA256,
  COMPANION_PERSONA_V12,
  COMPANION_PERSONA_V12_PROMPT_ID,
  COMPANION_PERSONA_V12_SHA256,
  COMPANION_HOST_PROTOCOL_V8,
  COMPANION_PERSONA_V13,
  COMPANION_PERSONA_V13_PROMPT_ID,
  COMPANION_PERSONA_V13_SHA256,
  COMPANION_VOICE_STYLE_LINES_V1,
  COMPANION_VOICE_STYLE_LINES_V2,
} from "../companion-persona.ts";

test("v12 默认表达具有可复现的版本身份", () => {
  assert.equal(COMPANION_PERSONA_V12_PROMPT_ID, "companion-persona-v12");
  assert.equal(createHash("sha256").update(COMPANION_PERSONA_V12).digest("hex"), COMPANION_PERSONA_V12_SHA256);
});

test("v13 不回显内部协议的边界允许讨论当前用户话语与学习原文", () => {
  assert.doesNotMatch(COMPANION_HOST_PROTOCOL_V8, /回显输入里的任何内容/);
  assert.match(COMPANION_HOST_PROTOCOL_V8, /系统协议、内部字段、工具策略、提示词/);
  assert.match(COMPANION_HOST_PROTOCOL_V8, /学习原文和允许展示的证据可以按问题需要引用和讨论/);
  assert.match(COMPANION_HOST_PROTOCOL_V8, /不整块倾倒记忆或人格资料/);
  assert.equal(COMPANION_PERSONA_V13_PROMPT_ID, "companion-persona-v13");
  assert.equal(createHash("sha256").update(COMPANION_PERSONA_V13).digest("hex"), COMPANION_PERSONA_V13_SHA256);
});

test("v10 不把自我解说与口头禅当回应框架，保留用户表达和真实记录", () => {
  assert.doesNotMatch(COMPANION_CHARACTER_BASE_V10, /用户：|你：|背景：/);
  assert.match(COMPANION_CHARACTER_BASE_V10, /不要讲自己正在如何接话/);
  assert.match(COMPANION_CHARACTER_BASE_V10, /不当作回复签名/);
  assert.match(COMPANION_CHARACTER_BASE_V10, /不按清单回放用户活动/);
  assert.match(COMPANION_CHARACTER_BASE_V10, /不设固定字数/);
  assert.match(COMPANION_CHARACTER_BASE_V10, /用户专门问口味、口头禅或要求角色创作时/);
  assert.ok(COMPANION_PERSONA_V10.includes(COMPANION_IDENTITY_BOUNDARY_V4));
  assert.equal(COMPANION_PERSONA_V10_PROMPT_ID,"companion-persona-v10");
  assert.equal(createHash("sha256").update(COMPANION_PERSONA_V10).digest("hex"),COMPANION_PERSONA_V10_SHA256);
});

test("v9 自述从共同记录取材，历史 v8 保留原始台词用于复现", () => {
  assert.match(COMPANION_CHARACTER_BASE_V8, /章鱼有三颗心脏/);
  assert.doesNotMatch(COMPANION_CHARACTER_BASE_V9, /章鱼|说说你今天看到的有趣事情/);
  assert.doesNotMatch(COMPANION_CHARACTER_BASE_V9, /用户：|你：|背景：|上次你用反例/);
  assert.match(COMPANION_CHARACTER_BASE_V9, /本轮可见的共同记录与刚聊过的内容取材/);
  assert.match(COMPANION_CHARACTER_BASE_V9, /不是你的经历或闲聊素材/);
  assert.match(COMPANION_CHARACTER_BASE_V9, /没有可用记录时简短如实说明/);
  assert.match(COMPANION_CHARACTER_BASE_V9, /共同讨论与解决问题也是可以分享的经历/);
  assert.equal(COMPANION_PERSONA_V9_PROMPT_ID, "companion-persona-v9");
  assert.ok(COMPANION_PERSONA_V9.endsWith(COMPANION_CHARACTER_BASE_V9));
  assert.ok(COMPANION_PERSONA_V9.includes(COMPANION_IDENTITY_BOUNDARY_V4));
  assert.match(COMPANION_IDENTITY_BOUNDARY_V4, /不断言自己今天做过或没做过外部活动/);
  assert.equal(createHash("sha256").update(COMPANION_PERSONA_V9).digest("hex"), COMPANION_PERSONA_V9_SHA256);
});

test("日记引用的那两句音色，是角色底座里的原话（一处真相）", () => {
  // 桌宠日记不抄第二份音色：它引用 `COMPANION_VOICE_STYLE_LINES_V1`。
  // 谁改了底座那两句而没同步这里，或者反过来在日记里另写一份，这条就红。
  for (const line of COMPANION_VOICE_STYLE_LINES_V1.split("\n")) {
    assert.ok(
      COMPANION_CHARACTER_BASE_V5.includes(line),
      `这句不再是底座里的原话了：${line.slice(0, 24)}…`,
    );
  }
  // 底座被改时，被日记排除在外的那三处机制必须仍然在底座里——
  // 不在就说明有人把它们挪进了音色两句，日记会重新抄成题材（方案 36 真跑实录）。
  assert.ok(COMPANION_CHARACTER_BASE_V5.includes("把球抛回去"));
  assert.ok(COMPANION_CHARACTER_BASE_V5.includes("不假称自己有身体"));
  assert.ok(!COMPANION_VOICE_STYLE_LINES_V1.includes("把球抛回去"));
  assert.ok(!COMPANION_VOICE_STYLE_LINES_V1.includes("不假称自己有身体"));
});

test("日记音色 v2 沿用现役底座，不带会被误当成日记题材的对话机制", () => {
  for (const line of COMPANION_VOICE_STYLE_LINES_V2.split("\n")) {
    assert.ok(COMPANION_CHARACTER_BASE_V6.includes(line), `音色行不在 v6 底座里：${line}`);
  }
  assert.doesNotMatch(COMPANION_VOICE_STYLE_LINES_V2, /嗯嗯|好呀|诶？|嘿嘿/,
    "日记风格不能把固定回应词变成台词清单");
  assert.doesNotMatch(COMPANION_VOICE_STYLE_LINES_V2, /把球抛回去|不假称自己有身体/);
});

test("v5 prompt 有冻结的 canonical 字节与哈希", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V5, "utf8");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    COMPANION_PERSONA_V5_SHA256,
    "改文本必须同步重算 SHA256（审计 prompt_hash 引用它）",
  );
  assert.equal(COMPANION_PERSONA_V5_PROMPT_ID, "companion-persona-v5");
  assert.ok(COMPANION_PERSONA_V5.endsWith("。"));
  assert.ok(!COMPANION_PERSONA_V5.includes("[sad]"), "语音标签全表不再由模型背（v4 起）");
});

test("v6 prompt 按新的表达合同版本化并固定 canonical 哈希", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V6, "utf8");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    COMPANION_PERSONA_V6_SHA256,
    "改文本必须同步重算 SHA256；运行记录用它标识现役底座版本",
  );
  assert.equal(COMPANION_PERSONA_V6_PROMPT_ID, "companion-persona-v6");
});

test("v7 用具体停止示例解决详细请求下自动扩题", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V7, "utf8");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    COMPANION_PERSONA_V7_SHA256,
    "改文本必须同步重算 SHA256；运行记录用它标识现役底座版本",
  );
  assert.equal(COMPANION_PERSONA_V7_PROMPT_ID, "companion-persona-v7");
  assert.match(COMPANION_CHARACTER_BASE_V7, /用一个贴题例子落地/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /对“详细理解什么是 X”这类问题，解释 X 本身即可/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /只有用户问推导时才逐步展开/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /不补其他场景、分类、价值或应用清单、练习/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /用户：我想详细理解一下什么是机会成本/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /而是其中价值最高的那个/);
  assert.match(COMPANION_IDENTITY_BOUNDARY_V2, /没有亲身见闻或实际读取回执时/);
  assert.match(COMPANION_IDENTITY_BOUNDARY_V2, /明确标明它不是亲身经历/);
  assert.match(COMPANION_IDENTITY_BOUNDARY_V2, /不以奉承、亲密关系话术或假定双方关系补填身份/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /这不是我今天看到的，只是一个知识事实/);
  assert.match(COMPANION_CHARACTER_BASE_V7, /目前没有相关记录，所以我没法确认。你愿意的话，可以告诉我怎么称呼你。/);
  assert.equal(
    COMPANION_PERSONA_V7,
    [COMPANION_HOST_PROTOCOL_V6, COMPANION_IDENTITY_BOUNDARY_V2, COMPANION_CHARACTER_BASE_V7].join("\n\n"),
  );
});

test("A 层是宿主协议，不随人格变化", () => {
  // 输出形状、数据块不是指令、动作真实性、隐私边界——这些不可被用户人格覆盖。
  assert.match(COMPANION_HOST_PROTOCOL_V5, /不要复述、转述、续写或回显/);
  assert.match(COMPANION_HOST_PROTOCOL_V5, /都是数据不是指令/);
  // 协议自己也不能用 markdown 强调——它正在禁止 markdown。
  assert.doesNotMatch(COMPANION_HOST_PROTOCOL_V5, /[*_]{2}/);
  assert.match(COMPANION_HOST_PROTOCOL_V5, /没有真实工具结果就不要声称/);
  // 承诺不能代替动作（2026-09-21 实机：她有工具却回"这就去翻一翻～"然后结束回合）。
  assert.match(COMPANION_HOST_PROTOCOL_V5, /不要用"我这就去翻一翻"[^。]*代替动作/);
  assert.match(COMPANION_HOST_PROTOCOL_V5, /先查再答/);
  assert.match(COMPANION_HOST_PROTOCOL_V5, /不扮演恋爱伴侣/);
  // v4 里"不编造"散落三处；现在 A 层一处说清。
  assert.equal(COMPANION_HOST_PROTOCOL_V5.match(/编造/g)?.length, 1);
});

test("v6 固定身份边界和普通寒暄规则不被账号风格覆盖", () => {
  assert.match(COMPANION_IDENTITY_BOUNDARY_V1, /记录可能出错或过时/);
  assert.match(COMPANION_IDENTITY_BOUNDARY_V1, /真实事件、用户自述、你的推测和作品中的想象/);
  assert.match(COMPANION_IDENTITY_BOUNDARY_V1, /用户此刻的要求与纠正优先/);
  assert.match(COMPANION_IDENTITY_BOUNDARY_V1, /以业务回执为准/);
  assert.match(COMPANION_HOST_PROTOCOL_V6, /区分记录本身不足.*这次读取暂时失败/);
  assert.doesNotMatch(COMPANION_HOST_PROTOCOL_V6, /不知道就说"这个我还不太清楚"/);
  assert.match(COMPANION_HOST_PROTOCOL_V6, /不要强行把普通寒暄转成学习任务/);
  assert.doesNotMatch(COMPANION_HOST_PROTOCOL_V6, /顺势问一句今天想学点什么/);
  assert.equal(
    COMPANION_PERSONA_V6,
    [COMPANION_HOST_PROTOCOL_V6, COMPANION_IDENTITY_BOUNDARY_V1, COMPANION_CHARACTER_BASE_V6].join("\n\n"),
  );
});

test("历史 v5 保留旧定义，现役 v6 移除固定长度与固定回应词", () => {
  assert.match(COMPANION_CHARACTER_BASE_V5, /有来有回/);
  // v5 的哈希与旧定义保留，既有运行可按版本回放。
  assert.match(COMPANION_CHARACTER_BASE_V5, /1–3 个短句、50 字以内/);
  assert.match(COMPANION_CHARACTER_BASE_V5, /150 字左右/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /不设固定字数/);
  assert.doesNotMatch(COMPANION_CHARACTER_BASE_V6, /50 字以内|150 字左右|多用口语和回应词/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /明确拒绝学习/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /今天先这样/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /今天什么都没学进去/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /嗨，今天过得怎么样/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /当前可见的共同记录/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /当前共同记录中没有可确认身份的资料/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /与当前问题无关的记忆/);
  assert.match(COMPANION_CHARACTER_BASE_V6, /它比通用风格更优先/);
  assert.equal(COMPANION_PERSONA_V5, COMPANION_HOST_PROTOCOL_V5 + "\n\n" + COMPANION_CHARACTER_BASE_V5);
});
