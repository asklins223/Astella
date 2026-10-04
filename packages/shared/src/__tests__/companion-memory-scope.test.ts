/**
 * 跨空间作用范围判据（`@ailearn/shared/companion-memory-scope`）的契约用例。
 *
 * 42 阶段 1 E 把它从抽取器提到共享层：worker 决定"这条记忆落哪一档"用它，
 * API 写入端决定"这条记忆准不准以账号级存在"也用它。两边共用一份，理由是
 * 同一句产品决定各判一次，漂移的方向通常是写入端那份更松。
 *
 * 样本直接取自 dev 库那批真种子记忆与产品文档里的对照句，不是编出来的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountPreferenceWriteDecision,
  memoryLooksWorkspaceBound,
  memoryScopeForKind,
} from "../companion-memory-scope.ts";

test("抽取侧：只有 preference 可能跨空间，其余留在原空间", () => {
  // 正向：偏好——关于"怎么学、怎么相处"——跟人走。
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "喜欢在安静时段学习"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "看新概念时更想先看反例，再看定义"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "习惯在晚上九点之后写笔记，白天只做采集"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "用户曾要求关闭桌宠的声音"), "global");
  // 负向：这四类绑定空间内的东西。
  assert.equal(memoryScopeForKind("interaction_note", "workspace", "portable", "被追问原因时会先举例"), "workspace");
  assert.equal(memoryScopeForKind("goal", "workspace", "portable", "下个月要考日语N3"), "workspace");
  assert.equal(memoryScopeForKind("learning_context", "workspace", "portable", "正在学习物理"), "workspace");
  assert.equal(memoryScopeForKind("episodic", "workspace", "portable", "第一次独立完成三分钟微旅程验证"), "workspace");
});

test("抽取侧：提到具体科目/考试的偏好留在原空间（收紧的那一半）", () => {
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "偏好短节奏学习，每次约10分钟"), "global");
  assert.equal(
    memoryScopeForKind("preference", "workspace", "portable", "用户正在学习数据库索引优化，理解速度较快"),
    "workspace",
    "科目绑定的偏好跑到别的空间去了——那个空间里没有这门课",
  );
  assert.equal(
    memoryScopeForKind("preference", "workspace", "portable", "用户之前主要专注于 N3 相关工作"),
    "workspace",
  );
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "这个班的作业每周三交"), "workspace");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable", "这门课的期中考试在下周"), "workspace");
});

test("抽取侧：服务端规则可以否决模型的 portable；缺省 binding 落本地", () => {
  assert.equal(
    memoryScopeForKind("preference", "workspace", "portable", "我正在学贝叶斯统计"),
    "workspace",
    "服务端规则必须能挡住模型误判的 portable",
  );
  assert.equal(
    memoryScopeForKind("preference", "workspace", "local", "喜欢在安静时段学习"),
    "workspace",
    "模型明确说这条只在这个空间成立时，规则不该覆盖它",
  );
  // 实测踩过的坑：写成 `=== "local"` 时这里会返回 global，等于开了一个"漏传就跨空间"的口子。
  assert.equal(
    memoryScopeForKind("preference", "workspace", undefined, "喜欢在安静时段学习"),
    "workspace",
    "没给 binding 时应当按本地处理（宁可少带，不可错带）",
  );
  assert.equal(memoryScopeForKind("preference", "workspace", undefined, undefined), "workspace");
});

test("抽取侧：非跨空间种类仍尊重模型给的 task 细分", () => {
  assert.equal(memoryScopeForKind("episodic", "task", "local", "这一轮的事"), "task");
  assert.equal(memoryScopeForKind("goal", "task", "local", "这一轮的目标"), "task");
  // 跨空间种类不吃 task：偏好不是"这一轮"的东西。
  assert.equal(memoryScopeForKind("preference", "task", "portable", "喜欢先看反例"), "global");
});

test("行内判据与范围判定说同一句话", () => {
  assert.equal(memoryLooksWorkspaceBound("他在学数据库索引这门课"), true);
  assert.equal(memoryLooksWorkspaceBound("回答时先给一句结论"), false);
  // 两类信号都要认：明确的本地指代，和具体科目/考试。
  assert.equal(memoryLooksWorkspaceBound("这个班的作业每周三交"), true);
  assert.equal(memoryLooksWorkspaceBound("偏好短节奏学习，每次约10分钟"), false);
});

test("本地指代认得材料、任务与书房（42 阶段 1 E 复审补齐）", () => {
  // 复审实测发现的口子：这些句子在别的书房里同样指向不存在的东西，
  // 而旧判据只认"班/课/学期"那一族，于是它们被当成了可跨书房的一般偏好。
  for (const content of [
    "讲这篇笔记时先给一句结论",
    "复习时先回看当前材料",
    "这项任务下周就要交",
    "这个书房的节奏比别的快",
    "这份材料里先看反例",
    "this note is easier with an example first",
    "current task needs a reminder",
    "this workspace runs slower",
  ]) {
    assert.equal(memoryLooksWorkspaceBound(content), true, `「${content}」没有被认成这个书房专属`);
  }
});

test("一般合作习惯仍然可以跨书房（判据收紧不能顺手收紧过头）", () => {
  // 每一句都是正向对照：判据多认了"笔记/任务/材料/书房"这族词之后，
  // 下面这些"怎么学、怎么相处"的偏好必须仍然是可携带的。
  for (const content of [
    "习惯晚上九点之后写笔记，白天只做采集",
    "看新概念时更想先看反例，再看定义",
    "讲新概念时先给一个日常类比",
    "提醒我先看反例",
    "我累的时候别催学习",
    "笔记写完先自己读一遍再给我看",
    "任务再多也一次只推进一件",
    "prefers one example before the definition",
  ]) {
    assert.equal(memoryLooksWorkspaceBound(content), false, `一般偏好被误判成本地：${content}`);
    assert.equal(
      memoryScopeForKind("preference", "workspace", "portable", content),
      "global",
      `一般偏好不能跨书房了：${content}`,
    );
    assert.deepEqual(
      accountPreferenceWriteDecision({ scope: "global", kind: "preference", content }),
      { ok: true },
      `一般偏好不能作为账号级保存：${content}`,
    );
  }
});

test("写入侧：普通全局偏好放行，非偏好种类与本地内容都拒", () => {
  assert.deepEqual(
    accountPreferenceWriteDecision({ scope: "global", kind: "preference", content: "习惯晚上学习" }),
    { ok: true },
  );
  // 非 preference：别的种类在另一个空间里根本不成立（PRODUCT.md 的裁决）。
  assert.deepEqual(
    accountPreferenceWriteDecision({ scope: "global", kind: "goal", content: "习惯晚上学习" }),
    { ok: false, reason: "kind_not_preference" },
  );
  assert.deepEqual(
    accountPreferenceWriteDecision({ scope: "global", kind: "interaction_note", content: "今天状态不错" }),
    { ok: false, reason: "kind_not_preference" },
  );
  // 本地正文。
  assert.deepEqual(
    accountPreferenceWriteDecision({ scope: "global", kind: "preference", content: "正在学数据库索引优化" }),
    { ok: false, reason: "content_workspace_bound" },
  );
});

test("写入侧：适用条件同样参与判定，省略不等于免检", () => {
  // 条件跟着记忆一起铺到别的空间去，所以"内容干净、条件绑定本地"一样是错的。
  assert.deepEqual(
    accountPreferenceWriteDecision({
      scope: "global",
      kind: "preference",
      content: "提醒我先看反例",
      appliesWhen: "复习这门课时",
    }),
    { ok: false, reason: "applies_when_workspace_bound" },
  );
  // 通用的条件照常放行。
  assert.deepEqual(
    accountPreferenceWriteDecision({
      scope: "global",
      kind: "preference",
      content: "提醒我先看反例",
      appliesWhen: "我累的时候",
    }),
    { ok: true },
  );
  // 清空条件（null）与没有条件是同一种形状，都按"没有条件"判。
  assert.deepEqual(
    accountPreferenceWriteDecision({
      scope: "global",
      kind: "preference",
      content: "提醒我先看反例",
      appliesWhen: null,
    }),
    { ok: true },
  );
});

test("写入侧：workspace / task 记忆从来就留在原空间，不该被这条守卫拦掉", () => {
  // 这条守卫只管"准不准以账号级存在"。若它顺手拦下正常写入，记忆中心会整个不能用，
  // 所以正向对照必须在这：workspace 记忆可以写任何内容，包括最本地的那种。
  for (const scope of ["workspace", "task", undefined, null]) {
    assert.deepEqual(
      accountPreferenceWriteDecision({ scope, kind: "goal", content: "下个月要考日语N3" }),
      { ok: true },
      `scope=${String(scope)} 的本地记忆被账号级守卫拦下了`,
    );
  }
});

test("写入侧与抽取侧的方向一致：同一句话，两边都说它留本地", () => {
  // 两个入口判的是同一句产品决定，任何一边松了就等于没有守卫。
  const samples = [
    "习惯晚上九点之后写笔记",
    "正在学数据库索引优化",
    "这个班的作业每周三交",
    "下个月要考日语N3",
    "偏好短节奏学习，每次约10分钟",
  ];
  for (const content of samples) {
    const extraction = memoryScopeForKind("preference", "workspace", "portable", content) === "global";
    const write = accountPreferenceWriteDecision({ scope: "global", kind: "preference", content }).ok;
    assert.equal(
      extraction,
      write,
      `两边对「${content}」的结论不一致：抽取侧 ${extraction ? "跨空间" : "留本地"}，写入侧 ${write ? "放行" : "拒绝"}`,
    );
  }
});