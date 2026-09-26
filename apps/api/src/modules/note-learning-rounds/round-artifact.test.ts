/**
 * 动态产物：确定性生产者的单元半边（39d W4-6 刀五）。
 *
 * 这一份是**单元**用例，不碰库也不碰桌面模板：产出必须"能放进模板里的那一份内容"
 * （若干 `ailearn-artifact-pane` 分屏），并且满足三条硬约束——文本转义、无脚本／无外部
 * 资源、同输入逐字节相同。落库、只追加、按 id 取整份那半边在
 * `note-learning-round-artifact-postgres.integration.ts`（双口径）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUND_ARTIFACT_MAX_CHARS_V1,
  buildDeterministicArtifactHtmlV1,
  escapeArtifactTextV1,
  type RoundArtifactInputV1,
} from "./round-artifact.ts";

function input(overrides: Partial<RoundArtifactInputV1> = {}): RoundArtifactInputV1 {
  return {
    explanation: "提取练习是先想再查：先自己试着说出来。",
    example: "比如合上书，把这一节讲给空气听一遍。",
    planSteps: ["先看小节标题", "再读第一段的例子"],
    ...overrides,
  };
}

/** 产物里出现的分屏（顺序就是上屏顺序）。 */
function panes(html: string): string[] {
  return html.match(/<section class="ailearn-artifact-pane"[^>]*>.*?<\/section>/g) ?? [];
}

test("转义：材料里带来的一句 <script> 只能成为文本，不许出现可执行形态", () => {
  const built = buildDeterministicArtifactHtmlV1(input({
    explanation: "<script>alert(1)</script>",
    example: "<img src=x onerror=alert(1)>",
    planSteps: ['" onclick="alert(1)'],
  }));
  assert.ok(built.ok);
  assert.equal(/<script/i.test(built.html), false, "产物里不许出现可执行的 <script");
  assert.equal(/<img/i.test(built.html), false);
  // 事件处理属性只可能长在标签里；转义之后的 `onclick=` 只是正文文字，不是属性。
  assert.equal(/<[^>]*\son\w+\s*=/i.test(built.html), false, "标签里不许出现事件处理属性");
  // 转义后的字样在（证明它确实是被"当文本"收下的，而不是被丢掉了）。
  assert.match(built.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(built.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(built.html, /&quot; onclick=&quot;alert\(1\)/);
});

test("转义函数：& < > \" ' 五个字符都要转（属性与文本共用这一个）", () => {
  assert.equal(escapeArtifactTextV1(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  // `&` 先转：否则 `&lt;` 会被二次转义成 `&amp;lt;`。
  assert.equal(escapeArtifactTextV1("a&b"), "a&amp;b");
});

test("确定性：同输入两次调用逐字节相同（不许有时间戳或随机 id）", async () => {
  const first = buildDeterministicArtifactHtmlV1(input());
  // 隔开一毫秒级的墙钟再跑第二次：`Date.now()` 这类"同毫秒看不出"的非确定性要能被抓住。
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = buildDeterministicArtifactHtmlV1(input());
  assert.ok(first.ok && second.ok);
  assert.equal(first.html, second.html);
  assert.ok(Buffer.from(first.html).equals(Buffer.from(second.html)), "逐字节比较也要相等");

  // 再钉一份逐字节的金样：最小输入的全部产出就是这一串，多一个注释/时间戳都会红。
  const golden = buildDeterministicArtifactHtmlV1({ explanation: "一句话解释。", planSteps: [] });
  assert.ok(golden.ok);
  assert.equal(
    golden.html,
    '<section class="ailearn-artifact-pane" data-artifact-step="0" data-artifact-step-display="1">'
    + '<h2 style="margin:0 0 6px;font-size:14px;line-height:1.5;font-weight:600">讲解</h2>'
    + '<p style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere">一句话解释。</p>'
    + "</section>",
  );
});

test("无脚本、无外部资源、样式内联：产物是自包含的一小片 HTML", () => {
  const built = buildDeterministicArtifactHtmlV1(input({
    explanation: "参考 https://example.com/material 这一页的说法。",
  }));
  assert.ok(built.ok);
  assert.equal(/<script/i.test(built.html), false);
  assert.equal(/<link\b/i.test(built.html), false);
  assert.equal(/\bsrc\s*=/i.test(built.html), false);
  assert.equal(/\bhref\s*=/i.test(built.html), false);
  // 正文里写着的一个 URL 只是文本：它转义后仍然是文本，不会被当成资源引用。
  assert.match(built.html, /https:\/\/example\.com\/material/);
  // 模板管边框与「第 N 步」，框内文字没有第二处样式表 ⇒ 必须内联。
  assert.match(built.html, /<p style="[^"]+"[^>]*>/);
});

test("屏数与输入对应：解释一屏、例子一屏（有才出）、计划步骤逐条一屏", () => {
  const built = buildDeterministicArtifactHtmlV1(input());
  assert.ok(built.ok);
  const sections = panes(built.html);
  assert.equal(sections.length, 1 + 1 + 2);
  // 步号是模板 `::before` 打印的那两口：`data-artifact-step` 0 起、display 1 起。
  assert.deepEqual(
    sections.map((section) => section.match(/data-artifact-step="(\d+)"/)?.[1]),
    ["0", "1", "2", "3"],
  );
  assert.deepEqual(
    sections.map((section) => section.match(/data-artifact-step-display="(\d+)"/)?.[1]),
    ["1", "2", "3", "4"],
  );
  // 顺序：讲解 → 例子 → 计划步骤。
  assert.match(sections[0] ?? "", /讲解/);
  assert.match(sections[1] ?? "", /例子/);
  assert.match(sections[2] ?? "", /先看小节标题/);
  assert.match(sections[3] ?? "", /再读第一段的例子/);

  // 没有例子 ⇒ 少一屏；空白步骤整条丢掉（一屏空白不是"第 N 步"）。
  const withoutExample = buildDeterministicArtifactHtmlV1(input({ example: undefined, planSteps: ["  ", "只留这一条"] }));
  assert.ok(withoutExample.ok);
  assert.equal(panes(withoutExample.html).length, 2);
});

test("超长输入：整份拒绝（over_quota），不许截断 HTML 来凑配额", () => {
  // 先用单字符正文量出固定开销，再凑到"恰好到界"与"越界一格"两档。
  const probe = buildDeterministicArtifactHtmlV1({ explanation: "x", planSteps: [] });
  assert.ok(probe.ok);
  const overhead = probe.html.length - 1;

  const exact = buildDeterministicArtifactHtmlV1({
    explanation: "a".repeat(ROUND_ARTIFACT_MAX_CHARS_V1 - overhead),
    planSteps: [],
  });
  assert.ok(exact.ok, "恰好到上界必须收得下（与 0285 的 char_length 上界同宽）");
  assert.equal(exact.html.length, ROUND_ARTIFACT_MAX_CHARS_V1);

  const over = buildDeterministicArtifactHtmlV1({
    explanation: "a".repeat(ROUND_ARTIFACT_MAX_CHARS_V1 - overhead + 1),
    planSteps: [],
  });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false ? over.reason : "", "over_quota");
  assert.equal("html" in over, false, "被拒的那一份不许留下任何半截 HTML");
});

test("空输入：如实说 empty（不产出只有一个空壳的产物）", () => {
  const built = buildDeterministicArtifactHtmlV1({ explanation: "   ", planSteps: [" ", ""] });
  assert.equal(built.ok, false);
  assert.equal(built.ok === false ? built.reason : "", "empty");
});
