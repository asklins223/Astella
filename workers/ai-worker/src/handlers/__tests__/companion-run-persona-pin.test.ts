/**
 * 一个 run 绑定哪一版人格（40 §4.8.4 / 40b §5.3.2 / A50）。
 *
 * ## 为什么这族判据以前是空的
 *
 * 固定人格这件事此前只有一处代码纪律：`WHERE persona_profile_revision IS NULL`。
 * 把那一行删掉，worker 的测试**一条都不红**，而后果是同一个 run 的前半段用旧人格、
 * 后半段用新人格——旧消息不会重写，于是产物与它声称的版本身份对不上，日志上也看不出来。
 * 账号人格有了「当前 / 待生效」两版之后还多一条：待生效那一版对**当前**这次 run
 * 不生效（它的生效时点是"下一次会话建立"，而判断发生在 run 建立之后）。
 *
 * 判据的对象是「这次调用绑哪一版、正文从哪来」，不是"文件里写了 persona 这个词"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { resolveRunPersonaPin } from "../companion-dialogue.ts";

const PRESET_VERSION = "pet-persona-presets-v1";

const pin = (overrides: Partial<Parameters<typeof resolveRunPersonaPin>[0]> = {}) =>
  resolveRunPersonaPin({
    pinnedRevision: null,
    pinnedExamplesRevision: null,
    pinnedDefaultExpressionVersion: null,
    currentRevision: 4,
    currentContent: { name: "当前那版" },
    stagedRevision: null,
    pinnedContent: null,
    currentDefaultExpressionVersion: PRESET_VERSION,
    ...overrides,
  });

test("首次固定：绑当前那一版，正文取当前档案，随后要写回 run", () => {
  const result = pin();
  assert.equal(result.fresh, true, "首次固定必须被认出来——否则不会把版本号写回 run");
  assert.equal(result.revision, 4);
  assert.equal(result.examplesRevision, 4);
  assert.deepEqual(result.content, { name: "当前那版" });
  assert.equal(result.defaultExpressionVersion, PRESET_VERSION);
});

test("已固定：只认 run 自己那个号，当前改成什么都与本次调用无关", () => {
  const result = pin({
    pinnedRevision: 3,
    pinnedExamplesRevision: 3,
    pinnedDefaultExpressionVersion: "pet-persona-presets-v0",
    // 用户在这次会话进行到一半时改了人格：当前已经是第 9 版。
    currentRevision: 9,
    currentContent: { name: "改过的那版" },
    pinnedContent: { name: "这一轮开始时的那版" },
  });
  assert.equal(result.fresh, false);
  assert.equal(result.revision, 3, "一次调用使用固定版本：不得被中途的修改带走");
  assert.equal(result.examplesRevision, 3);
  assert.deepEqual(result.content, { name: "这一轮开始时的那版" }, "正文必须来自那一版的不可变版本行");
  assert.equal(result.defaultExpressionVersion, "pet-persona-presets-v0", "默认表达版本也是绑定的身份之一");
});

test("已固定但示例版本号缺失时退回绑定号本身（不猜当前）", () => {
  const result = pin({
    pinnedRevision: 6,
    pinnedExamplesRevision: null,
    currentRevision: 9,
    pinnedContent: { name: "第六版" },
  });
  assert.equal(result.examplesRevision, 6);
});

test("待生效那一版对当前这次 run 不生效", () => {
  const result = pin({ stagedRevision: 5 });
  assert.equal(result.revision, 4, "排队的那一版只在激活之后才是当前");
  assert.deepEqual(result.content, { name: "当前那版" });
});

test("【硬断言】把待生效那一号当成候选绑上来 → 当场抛错", () => {
  // 这条不是防御性编程的仪式：它挡的是"将来有人把 pending 也当成候选"这一种改法。
  assert.throws(
    () => pin({ pinnedRevision: 5, stagedRevision: 5, pinnedContent: { name: "排队那版" } }),
    /must not bind the pending persona revision/,
    "一次已经建立（甚至已经固定）的 run 不得改绑到待生效那一版",
  );
});

test("从未设置过账号人格（revision 0）时内容为 null，用当前发布的默认", () => {
  const result = pin({ currentRevision: null, currentContent: null, stagedRevision: 1 });
  assert.equal(result.revision, 0);
  assert.equal(result.content, null, "第 0 版没有版本行，正文必须是 null 而不是空对象");
});

// ─── 源码守卫：把上面两条规则钉在真正执行的那段代码上 ────────────────────

const source = readFileSync(join(import.meta.dirname, "../companion-dialogue.ts"), "utf8");

/** 取"人格固定"注释到正文装配之间的那一段，避免扫到文件里别处的同名字样。 */
function pinBlock(): string {
  const start = source.indexOf("── 人格固定");
  const end = source.indexOf("const petProfileRow");
  assert.ok(start > 0 && end > start, "判据认不出人格固定那一段——它被搬走或改名了（那正是该红的时候）");
  return source.slice(start, end);
}

test("handler 必须把决策交给纯函数，而不是自己内联判断", () => {
  assert.ok(pinBlock().includes("resolveRunPersonaPin("), "装配段不再经过 resolveRunPersonaPin，两条规则就散掉了");
});

test("固定仍然只发生一次：写回 run 时必须带 persona_profile_revision IS NULL", () => {
  const block = pinBlock();
  assert.match(block, /AND persona_profile_revision IS NULL/,
    "少了这一句，两条并发轮次可能各写一次固定——固定版本就变成「最后写入者赢」");
  assert.ok(block.includes("if (personaPin.fresh)"), "只有首次固定才写回；已固定的 run 不得再改写自己");
});

test("已固定的正文只从不可变版本行取，不回读账号当前档案", () => {
  const block = pinBlock();
  const versionRead = block.indexOf("FROM companion_persona_profile_versions");
  assert.ok(versionRead > 0, "已固定那一版的正文必须来自版本行");
  assert.match(block, /WHERE user_id = \$\{run\.user_id\} AND revision = \$\{run\.persona_profile_revision\}/,
    "版本行必须按 run 自己固定的那个号读，而不是按当前档案的号");
});

test("待生效那一号只进断言，不进任何 persona 取值", () => {
  const block = pinBlock();
  // pending_revision 允许出现在 SELECT / 参数里（断言要看到它），但不得出现在
  // 任何赋值给 revision 或 content 的位置。
  assert.match(block, /SELECT revision, profile, pending_revision/,
    "断言需要看到待生效那一号——不读它，'已固定的恰好是排队那一版'就没人发现");
  assert.doesNotMatch(block, /personaProfileRevision = .*pending/,
    "待生效那一号不得被赋成这次调用的人格版本");
  assert.doesNotMatch(block, /personaProfileContent = .*pending/,
    "待生效那一版的正文不得被当成本次调用的正文");
});
