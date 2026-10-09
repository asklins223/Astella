import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../source-docx";

/**
 * 喂的是 mammoth 在真件 .docx 上产出的那一段 HTML（样式名→语义标签由 mammoth 负责，
 * 表格与图片的规则是这一层自己写的，所以用例只压自己写的那部分）。
 */
const AUDIT_HTML = [
  '<h1>记忆与间隔重复</h1>',
  '<p><strong>正文</strong> 里的一段，还有<em>斜体</em>。</p>',
  "<h2>第二章</h2>",
  "<ul><li>第一条</li><li>第二条</li></ul>",
  "<p>表格前面有一句 <a href=\"https://example.com/keep\">带链接的文字</a>。</p>",
  "<table><thead><tr><th><p>级别</p></th><th><p>数量</p></th></tr></thead>",
  "<tbody><tr><td><p>P0</p></td><td><p>4</p></td></tr>",
  "<tr><td><p>含竖线 | 的格</p></td><td><p>两行\n换行</p></td></tr></tbody></table>",
  '<p><img src="" /></p>',
  '<pre><span>const a = 1;</span></pre>',
].join("");

describe("Word 解析的 Markdown 落地", () => {
  it("标题、加粗、列表与链接照原样进来", () => {
    const { markdown } = htmlToMarkdown(AUDIT_HTML);
    expect(markdown).toContain("# 记忆与间隔重复");
    expect(markdown).toContain("## 第二章");
    expect(markdown).toContain("**正文**");
    expect(markdown).toMatch(/^-\s+第一条$/m);
    expect(markdown).toContain("[带链接的文字](https://example.com/keep)");
  });

  it("表格落成 GFM：表头行、分隔行、竖线转义、格内换行折成一行", () => {
    const { markdown } = htmlToMarkdown(AUDIT_HTML);
    expect(markdown).toContain("| 级别 | 数量 |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| P0 | 4 |");
    expect(markdown).toContain("| 含竖线 \\| 的格 | 两行 换行 |");
  });

  it("取不回来的图片在原位置保留提示，不混入 base64", () => {
    const { markdown, images } = htmlToMarkdown(AUDIT_HTML);
    expect(images).toBe(1);
    expect(markdown).not.toMatch(/!\[/);
    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("data:image");
  });

  it("整份只有图片但上传失败时保留缺失提示", () => {
    const converted = htmlToMarkdown('<p><img src="" /></p>');
    expect(converted.markdown).toContain("图片未能导入");
    expect(converted.images).toBe(1);
  });
});

it("Word 表格内的站内图片保留引用，文本样式与图片都能进入笔记", () => {
  const src = "/api/uploads/11111111-1111-4111-8111-111111111111/imports/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.png";
  const { markdown } = htmlToMarkdown(`<table><tr><td>图片</td></tr><tr><td><strong>原文</strong><img src="${src}" alt="示意" /></td></tr></table>`);
  expect(markdown).toContain(`![示意](${src})`);
  expect(markdown).toContain("**原文**");
});
