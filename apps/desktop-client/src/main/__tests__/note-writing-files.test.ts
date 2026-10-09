import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, symlink, stat, utimes, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_IPC_CHANNELS } from "@astella/shared/desktop-ipc-contracts";
import { registerNoteWritingChannels, rewriteNoteImagePaths } from "../note-writing-files";
const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), clipboard: vi.fn() }));
vi.mock("electron", () => ({ app: { getAppPath: () => process.cwd() }, BrowserWindow: class {}, ClipboardItem: class { constructor(readonly data: Record<string, string>) {} }, clipboard: { write: mocks.clipboard }, dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save }, nativeImage: {} }));
const directories: string[] = []; let id = 1000;
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.clearAllMocks(); });
function channel() {
  let operation: (event: unknown, window: unknown, input: unknown) => Promise<unknown>;
  registerNoteWritingChannels({ channel: ((name: string, _schema: unknown, run: typeof operation) => { if (name === DESKTOP_IPC_CHANNELS.noteWriting) operation = run; }) as never, requireM2Route: vi.fn(), contract: {} as never });
  const window = { id: ++id, once: vi.fn() }; return (request: unknown) => operation({}, window, { request });
}
async function directory() { const path = await realpath(await mkdtemp(join(tmpdir(), "note-writing-"))); directories.push(path); return path; }
describe("本地 Markdown 与图片资源", () => {
  it("Electron 44 将 Markdown 与富文本作为同一项复制，并等系统写入完成", async () => {
    const invoke = channel();
    let complete!: () => void;
    mocks.clipboard.mockReturnValueOnce(new Promise<void>(resolve => { complete = resolve; }));
    let settled = false;
    const result = invoke({ action: "clipboard", markdown: "**中文**\n原文" }).then(value => { settled = true; return value; });
    expect(mocks.clipboard).toHaveBeenCalledWith([expect.objectContaining({ data: {
      "text/plain": "**中文**\n原文", "text/html": expect.stringContaining("<strong>中文</strong>"),
    } })]);
    expect(settled).toBe(false);
    complete();
    expect(await result).toEqual({});
    mocks.clipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await expect(invoke({ action: "clipboard", html: "<p>原文</p>" })).rejects.toThrow("clipboard unavailable");
  });
  it("未经文件选择器授权不能读文件，选中文件后支持相对图片，符号链接不能越界", async () => {
    const root = await directory(), external = await directory(), path = join(root, "note.md"), invoke = channel();
    await writeFile(path, "正文"); await writeFile(join(root, "image.png"), "png"); await writeFile(join(external, "secret.png"), "secret"); await symlink(join(external, "secret.png"), join(root, "escape.png"));
    await expect(invoke({ action: "read", path })).rejects.toThrow("文件选择器"); mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    expect(await invoke({ action: "open" })).toMatchObject({ path, markdown: "正文" });
    expect(await invoke({ action: "image", path, src: "image.png" })).toMatchObject({ mime: "image/png", base64: Buffer.from("png").toString("base64") });
    await expect(invoke({ action: "image", path, src: "escape.png" })).rejects.toThrow("符号链接");
  });
  it("导出将多张图片收集到旁边目录，只改图片地址，再次保存保留资源路径并拒绝外部覆盖", async () => {
    const root = await directory(), path = join(root, "笔记.md"), invoke = channel(); mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path });
    const markdown = '图片 ![A](https://test/a.png)\n\n<img src="https://test/b.png" width="200" />\n\n`https://test/a.png`';
    const images = [{ src: "https://test/a.png", mime: "image/png", base64: Buffer.from("a").toString("base64") }, { src: "https://test/b.png", mime: "image/png", base64: Buffer.from("b").toString("base64") }];
    const result = await invoke({ action: "export", format: "md", markdown, images }) as { markdown: string; revision: number };
    expect(result.markdown).toContain("%E7%AC%94%E8%AE%B0.assets/"); expect(result.markdown).toContain('width="200"'); expect(result.markdown).toContain('`https://test/a.png`');
    const src = result.markdown.match(/\]\(([^)]+)\)/)![1]!; expect(await readFile(join(root, decodeURIComponent(src)), "utf8")).toBe("a");
    await invoke({ action: "save", path, revision: result.revision, markdown: result.markdown, images: [{ ...images[0], src }] });
    const revision = (await stat(path)).mtimeMs; await utimes(path, new Date(), new Date(Date.now() + 2000));
    await expect(invoke({ action: "save", path, revision, markdown: "不能覆盖" })).rejects.toThrow("其他应用");
  });
  it("批量整理资源到所选目录，重新读取相对地址可用", async () => {
    const root = await directory(), assets = await directory(), path = join(root, "note.md"), invoke = channel(); await writeFile(path, "![A](https://test/a.png)");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [path] }); await invoke({ action: "open" }); mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [assets] });
    const result = await invoke({ action: "assets", path, revision: (await stat(path)).mtimeMs, markdown: "![A](https://test/a.png)", images: [{ src: "https://test/a.png", mime: "image/png", base64: Buffer.from("a").toString("base64") }] }) as { markdown: string };
    const src = result.markdown.match(/\]\(([^)]+)\)/)![1]!; expect(src).toContain("../"); expect(await invoke({ action: "image", path, src })).toMatchObject({ base64: Buffer.from("a").toString("base64") });
    expect(rewriteNoteImagePaths('`![A](x)`\n\n![B](x)', new Map([["x", "y"]]))).toBe('`![A](x)`\n\n![B](y)');
  });
});
