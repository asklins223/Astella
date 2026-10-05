/**
 * `parse-source-html.ts` 的直接覆盖。
 *
 * ## 为什么是这一份而不是继续挂在 `parse-source-extra.test.ts` 后面
 *
 * 该模块 2026-10-05 从 `parse-source.ts` 拆出（`god-file-ratchet` 要求拆，不接受调大
 * 基线）。拆之前，它的行为是由 `parse-source-extra.test.ts` 经 `fetchUrlContentOnce`
 * **间接**跑到的；拆之后那一层依然在，但棘轮「没有测试引用的 handler」按**模块名**
 * 读测试源码，于是新模块被判成无人覆盖。
 *
 * 这份把之前只存在于注释里的口径变成真断言：注释说「`&nbsp;` 被换成普通空格
 * (U+0020)」，那就直接断字节；注释说「标题走 og:title 优先」，那就断优先级与
 * 引号不截断。判据读的是行为，不是文本。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractHtmlTitle, extractTextFromHtml } from "../handlers/parse-source-html.ts";

test("extractHtmlTitle：og:title 优先于 <title>", () => {
  const html = `<html><head>
    <meta property="og:title" content="社交平台上的标题">
    <title>页面自己的标题</title>
  </head><body></body></html>`;
  assert.equal(extractHtmlTitle(html), "社交平台上的标题");
});

test("extractHtmlTitle：没有 og:title 时回退 <title>，实体解码并归一空白", () => {
  assert.equal(
    extractHtmlTitle("<html><head><title>A &amp; B\n   C</title></head></html>"),
    "A & B C",
  );
});

test("extractHtmlTitle：og:title 用反向引用取 content，标题里的另一种引号不截断", () => {
  assert.equal(
    extractHtmlTitle(`<head><meta property="og:title" content="John's Blog"></head>`),
    "John's Blog",
  );
});

test("extractHtmlTitle：没有 <head> 时回退全文匹配；两者都没有则 null", () => {
  assert.equal(extractHtmlTitle("<title>裸标题</title>"), "裸标题");
  assert.equal(extractHtmlTitle("<div>只有正文</div>"), null);
});

test("extractHtmlTitle：截断到 100 字（与正文路径同口径）", () => {
  const title = extractHtmlTitle(`<title>${"長".repeat(180)}</title>`);
  assert.ok(title, "长标题也该提取得到");
  assert.equal([...title!].length, 100);
});

test("extractTextFromHtml：&nbsp; 换成普通空格 U+0020，而不是留在结果里", () => {
  const out = extractTextFromHtml("<p>甲&nbsp;&nbsp;乙</p>");
  assert.ok(out.includes("甲  乙"), `实体没被换成普通空格：${JSON.stringify(out)}`);
  assert.ok(!out.includes(" "), "结果里还留着不换行空格 U+00A0");
});

test("extractTextFromHtml：剥掉标签只留正文", () => {
  const out = extractTextFromHtml("<div><p>第一段</p><p>第二段</p></div>");
  assert.ok(out.includes("第一段") && out.includes("第二段"));
  assert.ok(!out.includes("<p>"), "标签没被剥掉");
});

test("extractTextFromHtml：图片换成 alt 文本，alt 里的实体先解码", () => {
  const out = extractTextFromHtml('<p><img src="https://x.test/a.png" alt="A &amp; B"></p>');
  assert.ok(out.includes("A & B"), `alt 没落进正文：${JSON.stringify(out)}`);
  assert.ok(!out.includes("<img"), "img 标签没被剥掉");
});

test("extractTextFromHtml：按 class 剔掉噪声容器，连带内容一起去掉", () => {
  // class 名取自模块自己的 NOISE_CLASS_PATTERNS，不自造——那张表里没有的名字
  // 本来就不该被剔，这一格断的也不是"任意 class 都能剔"。
  const out = extractTextFromHtml(
    '<div class="sidebar">侧边栏里的推荐</div><div class="rich_media_content">正文内容</div>',
  );
  assert.ok(out.includes("正文内容"), `正文没留下：${JSON.stringify(out)}`);
  assert.ok(!out.includes("侧边栏里的推荐"), `噪声没剔掉：${JSON.stringify(out)}`);
});

test("extractTextFromHtml：class 名不在噪声表里就不动它（表是白名单，不是通配）", () => {
  const out = extractTextFromHtml('<div class="advert">广告文案</div><div>正文</div>');
  assert.ok(out.includes("广告文案"), `未被列入噪声的容器不该被剔：${JSON.stringify(out)}`);
});