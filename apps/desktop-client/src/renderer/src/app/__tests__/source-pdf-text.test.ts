import { describe, expect, it } from "vitest";
import { normalizeRadicalCodepoints, pdfItemsToMarkdown, pdfPagesToMarkdown, type PdfTextItem } from "../source-pdf-text";

/**
 * 合成一份「带坐标的片段」：12pt 的行，行距 12，段距 28。
 * 这几个数与解析器的判据是同一套（行分组容差 4.2、空格空档 3、段距阈值取跳距中位数），
 * 所以用例改数字的时候，改的是几何，不是断言的措辞。
 */
const item = (str: string, x: number, y: number, options: { width?: number; height?: number; hasEOL?: boolean } = {}): PdfTextItem => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width: options.width ?? str.length * 6,
  height: options.height ?? 12,
  hasEOL: options.hasEOL ?? false,
});

describe("PDF 文字层的重建", () => {
  it("跳距明显宽于本文件中位数行距的那一行，另起一段", () => {
    const markdown = pdfItemsToMarkdown([
      item("第一段第一行", 0, 100),
      item("第一段第二行", 0, 88),
      item("第二段第一行", 0, 60),
      item("第二段第二行", 0, 48),
    ]);
    expect(markdown).toBe("第一段第一行第一段第二行\n\n第二段第一行第二段第二行");
  });

  it("中文折行相接，西文折行补一个空格", () => {
    expect(pdfItemsToMarkdown([item("慢慢读这一", 0, 100), item("份材料。", 0, 88)])).toBe("慢慢读这一份材料。");
    expect(pdfItemsToMarkdown([item("The study of spaced", 0, 100), item("repetition shows that", 0, 88)])).toBe(
      "The study of spaced repetition shows that",
    );
  });

  it("行尾连字符是被拆开的词，接回去而不是留一个横线", () => {
    expect(pdfItemsToMarkdown([item("the dy-", 0, 100), item("namic range", 0, 88)])).toBe("the dynamic range");
  });

  it("同一行里空档宽得像空格的两段，中间补空格", () => {
    expect(pdfItemsToMarkdown([item("Hello", 0, 100, { width: 30 }), item("world", 70, 100, { width: 30 })])).toBe("Hello world");
    expect(pdfItemsToMarkdown([item("紧", 0, 100, { width: 12 }), item("挨", 13, 100, { width: 12 })])).toBe("紧挨");
  });

  it("基线差在容差之内算同一行；hasEOL 说行结束了就起新行", () => {
    expect(pdfItemsToMarkdown([item("同一行前半", 0, 100), item("同一行后半", 0, 102.5)])).toBe("同一行前半同一行后半");
    expect(pdfItemsToMarkdown([item("页码", 300, 100, { hasEOL: true }), item("正文", 0, 100)])).toBe("页码正文");
  });

  it("部首区码位折回汉字，全角标点跟着原样留着", () => {
    expect(normalizeRadicalCodepoints("这⼀段的中⽂")).toBe(["这", "一", "段", "的", "中", "文"].join(""));
    expect(normalizeRadicalCodepoints("⾯向个⼈学习的桌⾯书房")).toBe("面向个人学习的桌面书房");
    expect(normalizeRadicalCodepoints("⼀段：测试（全角）、100%——不用改")).toBe("一段：测试（全角）、100%——不用改");
    expect(normalizeRadicalCodepoints("正常汉字与 full-width 混排")).toBe("正常汉字与 full-width 混排");
    expect(pdfItemsToMarkdown([item("⽂本层", 0, 100)])).toBe("文本层");
  });

  it("空片段与只有空白的行不产生段落", () => {
    expect(pdfItemsToMarkdown([])).toBe("");
    expect(pdfItemsToMarkdown([item("", 0, 100), item("   ", 0, 88)])).toBe("");
  });

  it("页与页之间空一段，没有文字的那一页不留痕", () => {
    const markdown = pdfPagesToMarkdown([[item("第一页正文", 0, 100)], [], [item("第三页正文", 0, 100)]]);
    expect(markdown).toBe("第一页正文\n\n第三页正文");
  });
});
