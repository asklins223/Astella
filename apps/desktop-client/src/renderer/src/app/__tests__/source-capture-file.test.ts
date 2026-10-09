// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CAPTURE_BYTES, MAX_DOCUMENT_BYTES, formatCaptureSize } from "../source-intake";
import { readCaptureFile, readCaptureFiles } from "../source-batch-capture";

/** 解析器换成假的：这一份用例只管**门**（能收什么、上限报什么数、失败的那一句怎么说）。 */
const doubles = vi.hoisted(() => ({ pdf: vi.fn(), docx: vi.fn() }));
vi.mock("../source-pdf", () => ({ extractPdfMarkdown: doubles.pdf }));
vi.mock("../source-docx", () => ({ extractDocxMarkdown: doubles.docx }));

const file = (name: string, body = "内容", size?: number) => {
  const created = new File([body], name);
  // jsdom 的 File 两个读取器都没有，而采集通道按字节读文本、按原始字节喂解析器。
  Object.defineProperty(created, "arrayBuffer", { value: () => Promise.resolve(new TextEncoder().encode(body).buffer) });
  if (size !== undefined) Object.defineProperty(created, "size", { value: size });
  return created;
};

beforeEach(() => {
  doubles.pdf.mockReset();
  doubles.docx.mockReset();
});

describe("一份文件能不能收进来", () => {
  it("文本文件照旧直接读正文", async () => {
    expect(await readCaptureFile(file("note.md", "# 标题"))).toEqual({ ok: true, text: "# 标题" });
  });

  it("GBK 的 .txt 收进来是正常汉字，不是一串替换字符", async () => {
    const created = new File(["占位"], "笔记.txt");
    const bytes = new Uint8Array([0xbc, 0xe4, 0xb8, 0xf4, 0xd6, 0xd8, 0xb8, 0xb4]);
    Object.defineProperty(created, "arrayBuffer", { value: () => Promise.resolve(bytes.buffer) });
    expect(await readCaptureFile(created)).toEqual({ ok: true, text: "间隔重复" });
  });

  it("空文件说清楚是空的", async () => {
    const read = await readCaptureFile(file("empty.txt", ""));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain("是空的");
  });

  it("旧版 .doc 给的是下一步，不是一句「暂不解析」", async () => {
    const read = await readCaptureFile(file("report.doc"));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain("另存为");
    expect(!read.ok && read.message).toContain(".docx");
    expect(doubles.docx).not.toHaveBeenCalled();
  });

  it("收不了的格式把支持的面报全", async () => {
    const read = await readCaptureFile(file("archive.zip"));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain("PDF");
    expect(!read.ok && read.message).toContain("Word");
  });

  it("纯文本超上限在读取之前就拦下", async () => {
    const read = await readCaptureFile(file("huge.md", "x", MAX_CAPTURE_BYTES + 1));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain(formatCaptureSize(MAX_CAPTURE_BYTES));
  });
});

describe("文档解析的门与回执", () => {
  it("原文超上限就不交给解析器", async () => {
    const read = await readCaptureFile(file("atlas.pdf", "x", MAX_DOCUMENT_BYTES + 1));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toContain(formatCaptureSize(MAX_DOCUMENT_BYTES));
    expect(doubles.pdf).not.toHaveBeenCalled();
  });

  it("PDF 解析出来的正文照原样交给采集任务", async () => {
    doubles.pdf.mockResolvedValue({ ok: true, markdown: "# 提取的正文", pages: 12 });
    const read = await readCaptureFile(file("atlas.pdf"));
    expect(read).toEqual({ ok: true, text: "# 提取的正文" });
    expect(doubles.pdf.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  });

  it("Word 图片已经在正文原位置，不再附加旧版只解析文字的声明", async () => {
    doubles.docx.mockResolvedValue({ ok: true, markdown: "正文\n\n![示意](/api/uploads/图片)", images: 2 });
    const read = await readCaptureFile(file("报告.docx"));
    expect(read.ok && read.text).toBe("正文\n\n![示意](/api/uploads/图片)");
  });

  it("解析失败的每一句都直接给读者", async () => {
    doubles.pdf.mockResolvedValue({ ok: false, message: "这份 PDF 没有可提取的文字层。" });
    const read = await readCaptureFile(file("scan.pdf"));
    expect(read.ok === false && read.message).toBe("这份 PDF 没有可提取的文字层。");
  });

  it("解析出来超正文上限：报真实字节数，不截断", async () => {
    // 4M 个汉字 = 12,000,000 字节，比 10 MB 的上限多出来那一截要在句子里说得出数。
    doubles.pdf.mockResolvedValue({ ok: true, markdown: "字".repeat(4_000_000), pages: 900 });
    const read = await readCaptureFile(file("book.pdf"));
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("11 MB");
    expect(read.ok === false && read.message).toContain("10 MB");
  });

  it("一批里读不进的留下报告，进度按份报出去", async () => {
    doubles.pdf.mockResolvedValue({ ok: true, markdown: "第一份", pages: 3 });
    doubles.docx.mockResolvedValue({ ok: false, message: "打不开" });
    const progress: string[] = [];
    const result = await readCaptureFiles(
      [file("a.pdf"), file("b.docx"), file("c.md", "# C")],
      50,
      (index, total, name) => progress.push(`${index}/${total}:${name}`),
    );
    expect(result.tasks.map((task) => task.request)).toEqual([
      { content: "第一份", title: "a" },
      { content: "# C", title: "c" },
    ]);
    expect(result.outcomes).toEqual([{ name: "b.docx", ok: false, message: "打不开" }]);
    expect(progress).toEqual(["0/3:a.pdf", "1/3:b.docx", "2/3:c.md"]);
  });
});
