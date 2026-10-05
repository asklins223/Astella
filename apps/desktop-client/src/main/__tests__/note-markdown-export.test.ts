import { describe, expect, it, vi } from "vitest";
import {
  allocateMarkdownFileName,
  exportNotesAsMarkdown,
  markdownFileStem,
} from "../note-markdown-export";

const NOTE = (id: string, title: string) => ({
  id,
  title,
  titleSource: "manual",
  currentVersionId: `${id}-version`,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  firstImageBlock: null,
  paragraphCount: 1,
} as never);

describe("Markdown 导出的文件名", () => {
  it("路径分隔符与保留字符换掉，标题里的空格留着", () => {
    expect(markdownFileStem("学习方法 / 学习方法论", "aaaaaaaa-1111")).toBe("学习方法 学习方法论");
    expect(markdownFileStem('第1章: "为什么"*?', "aaaaaaaa-1111")).toBe("第1章 为什么");
    // 结尾的点会被 Windows 自己吃掉，于是「A.」和「A」会撞成同一个文件。
    expect(markdownFileStem("复盘.", "aaaaaaaa-1111")).toBe("复盘");
  });

  it("标题整个被清洗掉或撞上保留设备名时，退回一个认得出的名字而不是空文件名", () => {
    expect(markdownFileStem("///", "abcdef12-1111")).toBe("笔记 abcdef12");
    expect(markdownFileStem("CON", "abcdef12-1111")).toBe("笔记 abcdef12");
    expect(markdownFileStem("   ", "abcdef12-1111")).toBe("笔记 abcdef12");
  });

  it("同名往后排，且按小写去撞（macOS 上 .md 与 .MD 是同一个文件）", () => {
    const taken = new Set(["读书.md", "读书 (2).md"]);
    expect(allocateMarkdownFileName("读书", taken)).toBe("读书 (3).md");
    expect(allocateMarkdownFileName("读书", new Set(["读书.md"]))).toBe("读书 (2).md");
    expect(allocateMarkdownFileName("新笔记", taken)).toBe("新笔记.md");
  });
});

describe("Markdown 目录导出", () => {
  it("读者取消时一次网络往返都不发生，也没写过任何文件", async () => {
    const listNotes = vi.fn();
    const writeNote = vi.fn();
    const result = await exportNotesAsMarkdown({
      listNotes, writeNote, fetchMarkdown: vi.fn(),
      pickDirectory: async () => null, existingNames: async () => new Set(),
    });
    expect(result).toEqual({ version: 1, canceled: true, directory: null, total: 0, exported: 0, failed: 0 });
    expect(listNotes).not.toHaveBeenCalled();
    expect(writeNote).not.toHaveBeenCalled();
  });

  it("一篇一个文件；单篇取不到只记失败，不打断同一批的其他篇", async () => {
    const notes = [NOTE("n1", "记忆研究"), NOTE("n2", "阅读节奏"), NOTE("n3", "间隔重复")];
    const written = new Map<string, string>();
    const result = await exportNotesAsMarkdown({
      listNotes: async () => notes,
      fetchMarkdown: async (noteId) => {
        if (noteId === "n2") throw new Error("这一篇没取到");
        return `# ${noteId}\n`;
      },
      pickDirectory: async () => "/tmp/export",
      existingNames: async () => new Set(["记忆研究.md"]),
      writeNote: async (filePath, text) => { written.set(filePath, text); },
    });
    // 回执恒满足 exported + failed === total：读者需要知道**少了几篇**。
    expect(result).toMatchObject({ canceled: false, directory: "/tmp/export", total: 3, exported: 2, failed: 1 });
    // 目录里读者自己那份同名文件不被覆盖，新的一份往后排。
    expect([...written.keys()].sort()).toEqual([
      "/tmp/export/记忆研究 (2).md",
      "/tmp/export/间隔重复.md",
    ]);
    expect(written.get("/tmp/export/间隔重复.md")).toBe("# n3\n");
  });

  it("批量里已经写过的名字不会被后一篇抢走", async () => {
    const result = await exportNotesAsMarkdown({
      listNotes: async () => [NOTE("n1", "同名"), NOTE("n2", "同名"), NOTE("n3", "同名")],
      fetchMarkdown: async (noteId) => noteId,
      pickDirectory: async () => "/tmp/export",
      existingNames: async () => new Set(),
      writeNote: async () => undefined,
    });
    expect(result).toMatchObject({ total: 3, exported: 3, failed: 0 });
  });
});