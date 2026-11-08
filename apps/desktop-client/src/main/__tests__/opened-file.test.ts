import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock("../gateway/desktop-gateway-ns-source", () => ({
  uploadBundleImage: vi.fn(),
}));
vi.mock("../note-doc/note-writing-files", () => ({
  downloadImage: vi.fn(),
  isNoteWritingPathGranted: vi.fn(async () => true),
  markdownImageSources: vi.fn(() => []),
  rewriteNoteImagePaths: vi.fn((markdown: string) => markdown),
}));

const { openedMarkdownPathsFromArgv, openedFileIdentity, isMarkdownFileName } = await import("../note-doc/opened-file");

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "opened-file-")));
  directories.push(path);
  return path;
}

describe("系统文件关联的路径判据", () => {
  it("只认 Markdown 后缀，大小写不敏感", () => {
    for (const name of ["a.md", "B.MARKDOWN", "c.mdown", "d.mkd"]) expect(isMarkdownFileName(name)).toBe(true);
    for (const name of ["a.txt", "a.mdx", "a.md.bak", "md", ""]) expect(isMarkdownFileName(name)).toBe(false);
  });

  it("argv 里只留下真实存在的 Markdown：开关、入口脚本、不存在的路径都跳过", async () => {
    const root = await directory();
    await writeFile(join(root, "一篇.md"), "# 标题");
    await writeFile(join(root, "说明.txt"), "不是 Markdown");
    const found = await openedMarkdownPathsFromArgv([
      "/Applications/Astella.app/Contents/MacOS/Astella",
      "--remoteDebuggingPort", "9222",
      join(root, "一篇.md"),
      "说明.txt",
      "不存在.md",
      "--flag.md",
    ], root);
    expect(found).toEqual([join(root, "一篇.md")]);
  });

  it("相对路径按启动目录解析；同一路径重复出现只留一条由 broker 去重", async () => {
    const root = await directory();
    await writeFile(join(root, "note.md"), "正文");
    expect(await openedMarkdownPathsFromArgv(["note.md"], root)).toEqual([join(root, "note.md")]);
  });

  it("身份取 realpath，目录或非 Markdown 不交出去", async () => {
    const root = await directory();
    const path = join(root, "note.md");
    await writeFile(path, "正文");
    await mkdir(join(root, "folder.md"));
    const identity = await openedFileIdentity(path);
    expect(identity).toMatchObject({ version: 1, path, name: "note.md", size: Buffer.byteLength("正文") });
    expect(await openedFileIdentity(join(root, "folder.md"))).toBeNull();
    expect(await openedFileIdentity(join(root, "missing.md"))).toBeNull();
  });
});
