// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { MAX_SOURCE_TEXT_BYTES } from "@astella/shared/object-transfer-contracts";
import {
  DOCUMENT_FILE_PATTERN,
  LEGACY_DOCUMENT_FILE_PATTERN,
  MAX_CAPTURE_BYTES,
  MAX_DOCUMENT_BYTES,
  NOTE_PAPER_IMAGE_DROP_ATTR,
  TEXT_FILE_PATTERN,
  captureBytes,
  decodeCaptureText,
  formatCaptureSize,
  imageOnlyFiles,
  isOwnedDropTarget,
  markLinkSeen,
  readSeenLinks,
  titleFromFileName,
} from "../source-intake.ts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe("source-intake", () => {
  it("文本后缀与文档后缀各管各的：PDF 是解析，不是读文本", () => {
    expect(TEXT_FILE_PATTERN.test("note.md")).toBe(true);
    expect(TEXT_FILE_PATTERN.test("app.tsx")).toBe(true);
    expect(TEXT_FILE_PATTERN.test("data.csv")).toBe(true);
    expect(TEXT_FILE_PATTERN.test("photo.png")).toBe(false);
    expect(TEXT_FILE_PATTERN.test("deck.pdf")).toBe(false);
    expect(TEXT_FILE_PATTERN.test("archive.zip")).toBe(false);
    expect(DOCUMENT_FILE_PATTERN.test("deck.pdf")).toBe(true);
    expect(DOCUMENT_FILE_PATTERN.test("报告.DOCX")).toBe(true);
    expect(DOCUMENT_FILE_PATTERN.test("legacy.doc")).toBe(false);
    expect(LEGACY_DOCUMENT_FILE_PATTERN.test("legacy.doc")).toBe(true);
  });

  it("单份正文上限只有一个源，尺寸文案到 MB 一档", () => {
    expect(MAX_CAPTURE_BYTES).toBe(MAX_SOURCE_TEXT_BYTES);
    expect(MAX_CAPTURE_BYTES).toBe(10 * 1024 * 1024);
    expect(captureBytes("a".repeat(1024))).toBe(1024);
    expect(formatCaptureSize(512)).toBe("512 字节");
    expect(formatCaptureSize(2048)).toBe("2.0 KB");
    expect(formatCaptureSize(MAX_CAPTURE_BYTES)).toBe("10 MB");
    expect(formatCaptureSize(MAX_DOCUMENT_BYTES)).toBe("40 MB");
  });

  it("文本解码：UTF-8 严格优先，其次 GBK，两种都不是就如实说", () => {
    expect(decodeCaptureText(new TextEncoder().encode("间隔重复"))).toEqual({ ok: true, text: "间隔重复" });
    // Windows 记事本的「ANSI」就是 GBK：过去 file.text() 不报错地把它变成一串替换字符。
    expect(decodeCaptureText(new Uint8Array([0xbc, 0xe4, 0xb8, 0xf4, 0xd6, 0xd8, 0xb8, 0xb4]))).toEqual({ ok: true, text: "间隔重复" });
    // BOM 不留在正文里。
    expect(decodeCaptureText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ ok: true, text: "A" });
    const binary = decodeCaptureText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xff]));
    expect(binary.ok).toBe(false);
    expect(binary.ok === false && binary.message).toContain("另存为 UTF-8");
  });

  it("文件名去后缀做标题，无后缀原样返回", () => {
    expect(titleFromFileName("study-notes.md")).toBe("study-notes");
    expect(titleFromFileName("README")).toBe("README");
    expect(titleFromFileName("  ")).toBe("");
  });

  it("问过的链接只记最近 100 个", () => {
    const storage = memoryStorage();
    expect(readSeenLinks(storage).size).toBe(0);
    markLinkSeen("https://a.test/1", storage);
    expect(readSeenLinks(storage).has("https://a.test/1")).toBe(true);
    for (let index = 0; index < 120; index += 1) {
      markLinkSeen(`https://a.test/${index}`, storage);
    }
    const seen = readSeenLinks(storage);
    expect(seen.size).toBeLessThanOrEqual(100);
    expect(seen.has("https://a.test/119")).toBe(true);
  });

  it("坏掉的存储不炸，退回空集合", () => {
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readSeenLinks(broken)).toEqual(new Set());
    expect(markLinkSeen("https://a.test/1", broken).has("https://a.test/1")).toBe(true);
    expect(readSeenLinks(null)).toEqual(new Set());
  });

  /** jsdom 造不出真 DataTransfer，而这两条判据只读 `files` 一项。 */
  function transferOf(...files: { name: string; type: string }[]): DataTransfer {
    return {
      files: files.map((file) => new File(["内容"], file.name, { type: file.type })),
    } as unknown as DataTransfer;
  }
  const PNG = { name: "截屏.png", type: "image/png" };
  const MARKDOWN = { name: "note.md", type: "text/markdown" };

  it("整份都是图片才算「往正文里放图」，混进别的文件就交回采集器", () => {
    expect(imageOnlyFiles(transferOf(PNG)).map((file) => file.name)).toEqual(["截屏.png"]);
    expect(imageOnlyFiles(transferOf(PNG, { name: "b.jpg", type: "image/jpeg" }))).toHaveLength(2);
    expect(imageOnlyFiles(transferOf(PNG, MARKDOWN))).toEqual([]);
    expect(imageOnlyFiles(transferOf(MARKDOWN))).toEqual([]);
    expect(imageOnlyFiles(null)).toEqual([]);
    expect(imageOnlyFiles({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });

  it("落点归属：编辑器与表单收文字，笔记纸面只收整份图片", () => {
    const paper = document.createElement("div");
    paper.setAttribute(NOTE_PAPER_IMAGE_DROP_ATTR, "");
    const spot = document.createElement("span");
    paper.appendChild(spot);
    const input = document.createElement("input");
    const chrome = document.createElement("div");

    expect(isOwnedDropTarget(spot, transferOf(PNG))).toBe(true);
    // 同一处落点，拖的是文本文件：纸面不认领，全局浮层该照常 arm 去收来源。
    expect(isOwnedDropTarget(spot, transferOf(MARKDOWN))).toBe(false);
    expect(isOwnedDropTarget(chrome, transferOf(PNG))).toBe(false);
    expect(isOwnedDropTarget(input, transferOf(PNG))).toBe(true);
    expect(isOwnedDropTarget(document.body, null)).toBe(false);
  });
});
