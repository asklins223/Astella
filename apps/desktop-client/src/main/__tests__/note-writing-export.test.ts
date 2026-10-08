import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { noteExportHtml, noteExportDocx } from "../note-writing-export";

function zipEntry(zip: Buffer, name: string): string {
  let offset = zip.indexOf(Buffer.from("PK\x01\x02"));
  while (offset >= 0 && offset + 46 <= zip.length) {
    const size = zip.readUInt32LE(offset + 20), length = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const filename = zip.subarray(offset + 46, offset + 46 + length).toString();
    if (filename === name) { const local = zip.readUInt32LE(offset + 42), start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), bytes = zip.subarray(start, start + size); return (zip.readUInt16LE(offset + 10) === 8 ? inflateRawSync(bytes) : bytes).toString(); }
    offset = zip.indexOf(Buffer.from("PK\x01\x02"), offset + 46 + length + extra + comment);
  }
  throw new Error(`Missing ${name}`);
}
describe("笔记的可携带导出", () => {
  it("HTML 保留样式、目录、脚注和有编号公式，图片完全内嵌且过滤危险 HTML", () => {
    const source = ['# 推导', '[toc]', '<p style="text-align:center;line-height:2.4;color:#a44b3b;background-image:url(https://bad.test)"><mark>重点</mark> H<sub>2</sub>O x<sup>2</sup> 参考<sup data-note-ref="note">[note]</sup> $x^2$</p>', String.raw`$$
E=mc^2
\label{one}
$$`, String.raw`参照 $\eqref{one}$`, '[^note]: 注释内容', '![图](https://image.test/a.png)', '<script>alert(1)</script>'].join('\n\n');
    const html = noteExportHtml("导出检查", source, new Map([["https://image.test/a.png", "data:image/png;base64,AAAA"]]));
    expect(html).toContain('href="#heading-1"'); expect(html).toContain('<mark>重点</mark>'); expect(html).toContain('<sub>2</sub>'); expect(html).toContain('<sup>2</sup>');
    expect(html).toContain('text-align:center'); expect(html).toContain('line-height:2.4'); expect(html).toContain('data:image/png;base64,AAAA'); expect(html).toContain('注释内容');
    expect(html).toContain('katex-display'); expect(html).not.toContain('katex-error'); expect(html).not.toContain('<script'); expect(html).not.toContain('background-image');
    // Inline math stays inline, including inside a styled paragraph.
    expect((html.match(/class="katex-display"/g) ?? []).length).toBe(1);
  });
  it("Word 使用可编辑公式、文字样式、段落排版、原比例图片和真实列表编号", async () => {
    const png = Buffer.alloc(24); png.writeUInt32BE(400, 16); png.writeUInt32BE(200, 20);
    const markdown = '<p style="text-align:center;line-height:2;color:#a44b3b;font-size:24px;font-family:sans-serif;margin-left:2em"><strong>彩色</strong> <mark>重点</mark></p>\n\n$$\n\\frac{x^2}{y}+\\sqrt{z}\n\\label{eq-one}\n$$\n\n1. 第一项\n2. 第二项\n\n![图](image.png)\n\n| 甲 | 乙 |\n| --- | --- |\n| A | B |';
    const buffer = await noteExportDocx("测试笔记", markdown, new Map([["image.png", `data:image/png;base64,${png.toString("base64")}`]]));
    const xml = zipEntry(buffer, "word/document.xml");
    expect(xml).toContain('<m:oMath'); expect(xml).toContain('<m:f>'); expect(xml).toContain('<m:sSup>'); expect(xml).toContain('<m:rad>'); expect(xml).not.toContain("\\frac");
    expect(xml).toContain('w:color w:val="a44b3b"'); expect(xml).toContain('w:jc w:val="center"'); expect(xml).toContain('w:line="480"'); expect(xml).toContain('w:sz w:val="36"');
    expect(xml).toContain('<w:numPr>'); expect(xml).toContain('<w:tbl>'); expect(xml).toContain('cx="3810000" cy="1905000"'); expect(xml).not.toContain('[图片：');
  });
});
