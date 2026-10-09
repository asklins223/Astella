import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ dialog: { showOpenDialog: vi.fn() } }));
import { bundleTestables } from "../markdown-bundle-import";
import { markdownImageSources, rewriteNoteImagePaths } from "../note-writing-files";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const url = "/api/uploads/11111111-1111-4111-8111-111111111111/imports/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.png";
it("reference images, escaped paths and sized HTML images rewrite without changing code or links", () => {
  const source = '![图][ref]\n\n[ref]: <images/a b.png> "title"\n\n<img src="images/a&amp;b.png" width="320">\n\n![转义](images/a\\(b\\).png)\n\n`![例子](images/a.png)`\n\n[普通链接](images/a.png)';
  expect(markdownImageSources(source)).toEqual(["images/a b.png", "images/a&b.png", "images/a(b).png"]);
  const rewritten = rewriteNoteImagePaths(source, new Map([['images/a b.png', url], ['images/a&b.png', url], ['images/a(b).png', url]]));
  expect(rewritten).toContain(`![图](${url} "title")`);
  expect(rewritten).toContain(`src="${url}" width="320"`);
  expect(rewritten).toContain(`![转义](${url})`);
  expect(rewritten).toContain('`![例子](images/a.png)`');
  expect(rewritten).toContain('[普通链接](images/a.png)');
  expect(rewritten).not.toContain('[ref]:');
});
it("shared reference definitions stay available to ordinary links", () => {
  const source = '![图][ref]\n\n[原图][ref]\n\n[ref]: assets/a.png';
  const rewritten = rewriteNoteImagePaths(source, new Map([["assets/a.png", url]]));
  expect(rewritten).toContain(`![图](${url})`);
  expect(rewritten).toContain('[原图][ref]'); expect(rewritten).toContain('[ref]: assets/a.png');
});
it("nested paths, encoded filenames and case differences resolve inside a Markdown bundle", () => {
  const entries = new Map([["assets/中文 图.PNG", 12]]);
  const reader = { entries, lower: new Map([["assets/中文 图.png", "assets/中文 图.PNG"]]), skipped: new Map(), read: vi.fn() };
  const refs = bundleTestables.planFileReferences("notes/note.md", '![图](../assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png)', reader);
  expect(refs).toMatchObject([{ kind: "local", path: "assets/中文 图.PNG" }]);
  expect(bundleTestables.planFileReferences("note.md", `![站内](${url})`, reader)).toEqual([]);
  expect(bundleTestables.isSafeEntry("../../etc/password")).toBe(false);
});
it("folder and zip readers preserve identical Markdown and asset bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "markdown-bundle-test-")); dirs.push(root);
  await mkdir(join(root, "assets")); await writeFile(join(root, "note.md"), "![图](assets/a.png)"); await writeFile(join(root, "assets/a.png"), "image");
  const folder = await bundleTestables.readFolderBundle(root);
  const archive = join(root, "bundle.zip"); await writeFile(archive, zipSync({ "note.md": strToU8("![图](assets/a.png)"), "assets/a.png": strToU8("image"), "../escape.png": strToU8("hidden") }));
  const zip = await bundleTestables.readZipBundle(archive);
  expect((await bundleTestables.planBundle(folder)).locals).toEqual(["assets/a.png"]);
  expect((await bundleTestables.planBundle(zip)).locals).toEqual(["assets/a.png"]);
  expect(await zip.read("assets/a.png")).toEqual(await folder.read("assets/a.png"));
  expect(zip.entries.has("../escape.png")).toBe(false);
});
