import { app, BrowserWindow, clipboard, dialog, nativeImage } from "electron";
import { readFile, readdir, realpath, stat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, basename, resolve, relative, extname, join, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { z } from "zod";
import { DESKTOP_IPC_CHANNELS, requestMetaSchema, noteWritingActionSchema, noteWritingResultSchema, type NoteWritingResult } from "@astella/shared/desktop-ipc-contracts";
import { isNonPublicAIEndpointAddress } from "@astella/shared/public-json-http";
import { noteMarkdownSyntax } from "@astella/shared/note-markdown";
import { noteExportHtml, noteExportDocx } from "./note-writing-export";
import type { RestChannelDeps } from "./desktop-ipc-rest";
const MAX_IMAGE = 12_000_000;
const roots = new Map<number, Set<string>>();
const mimeFor = (path: string) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()];
export function rewriteNoteImagePaths(markdown: string, replacements: Map<string, string>): string {
  const edits = new Map<string, { from: number; to: number; value: string }>();
  const walk = (node: { type: string; url?: string; children?: unknown[]; position?: { start: { offset?: number }; end: { offset?: number } } }) => {
    if (node.type === "image" && replacements.has(node.url ?? "")) {
      const from = node.position?.start.offset, to = node.position?.end.offset; if (from !== undefined && to !== undefined) {
        const key = `${from}:${to}`, original = edits.get(key)?.value ?? markdown.slice(from, to), src = node.url!, target = replacements.get(src)!;
        edits.set(key, { from, to, value: original.includes("<img") ? original.replaceAll(`src="${src.replace(/&/g, "&amp;")}"`, `src="${target}"`).replaceAll(`src='${src}'`, `src='${target}'`) : original.replace(src, target) });
      }
    } node.children?.forEach(child => walk(child as never));
  }; walk(noteMarkdownSyntax(markdown));
  for (const edit of [...edits.values()].sort((a, b) => b.from - a.from)) markdown = markdown.slice(0, edit.from) + edit.value + markdown.slice(edit.to);
  return markdown;
}
async function downloadImage(url: string, redirects = 0): Promise<{ mime: string; base64: string }> {
  const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password || redirects > 3) throw new Error("图片下载仅支持公开 HTTPS 地址");
  const addresses = await lookup(parsed.hostname, { all: true }); if (!addresses.length || addresses.some(address => isNonPublicAIEndpointAddress(address.address))) throw new Error("图片地址不能指向本机或内部网络");
  const address = addresses[0]!;
  return new Promise((resolveImage, reject) => {
    const request = httpsRequest(parsed, { lookup: (_host, _opts, callback) => callback(null, address.address, address.family), timeout: 15000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) { response.resume(); downloadImage(new URL(response.headers.location, parsed).href, redirects + 1).then(resolveImage, reject); return; }
      const mime = String(response.headers["content-type"] ?? "").split(";")[0]!;
      if (response.statusCode !== 200 || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) { response.resume(); reject(new Error("图片地址未返回支持的图片")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_IMAGE) { response.destroy(new Error("图片超过 12 MB")); return; } chunks.push(chunk); });
      response.on("end", () => resolveImage({ mime, base64: Buffer.concat(chunks).toString("base64") })); response.on("error", reject);
    }); request.on("timeout", () => request.destroy(new Error("图片下载超时"))); request.on("error", reject); request.end();
  });
}
async function atomicNoteWrite(path: string, bytes: string | Buffer) {
  const temporary = `${path}.${createHash("sha256").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 10)}.tmp`;
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
async function katexExportCss() {
  const require = createRequire(join(app.getAppPath(), "package.json")), path = require.resolve("katex/dist/katex.min.css"); let css = await readFile(path, "utf8");
  const files = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(match => match[1]!))];
  for (const file of files) css = css.replaceAll(`url(${file})`, `url(data:font/woff2;base64,${(await readFile(join(dirname(path), file))).toString("base64")})`);
  return css;
}
export function registerNoteWritingChannels(deps: Pick<RestChannelDeps, "channel" | "requireM2Route" | "contract">) {
  deps.channel(DESKTOP_IPC_CHANNELS.noteWriting, z.object({ meta: requestMetaSchema, request: noteWritingActionSchema }), async (_event, window, input): Promise<NoteWritingResult> => {
    deps.requireM2Route(deps.contract, "note.detail");
    const request = input.request, granted = roots.get(window.id) ?? new Set<string>();
    if (!roots.has(window.id)) window.once("closed", () => roots.delete(window.id)); roots.set(window.id, granted);
    const grant = async (path: string) => { granted.add(await realpath(path)); };
    const allowed = async (path: string, directory = false) => { const canonical = await realpath(directory ? path : dirname(path));
      if (![...granted].some(root => { const rel = relative(root, canonical); return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); })) throw new Error("请先通过文件选择器打开这个目录");
      const target = resolve(canonical, directory ? "." : basename(path));
      try { const actual = await realpath(target); if (actual !== target) throw new Error("资源路径不能通过符号链接离开笔记目录"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return target;
    };
    if (request.action === "clipboard") { const images = new Map((request.images ?? []).map(image => [image.src, `data:${image.mime};base64,${image.base64}`]));
      const html = request.markdown === undefined ? request.html ?? "" : noteExportHtml("", request.markdown, images).split("<body>")[1]?.split("</body>")[0] ?? "";
      clipboard.write({ text: request.markdown ?? "", html }); return {}; }
    if (request.action === "folder") {
      const picked = await dialog.showOpenDialog(window, { title: "打开 Markdown 文件夹", properties: ["openDirectory"] }); if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
      const root = picked.filePaths[0]; await grant(root); const entries: { path: string; name: string }[] = [];
      const scan = async (directory: string, depth: number) => { for (const entry of await readdir(directory, { withFileTypes: true })) { if (entries.length >= 500 || entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name); if (entry.isDirectory() && depth < 5) await scan(path, depth + 1); else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) entries.push({ path, name: relative(root, path) }); } };
      await scan(root, 0); return { path: root, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (request.action === "open" || request.action === "read") {
      let path = request.path;
      if (request.action === "open") { const picked = await dialog.showOpenDialog(window, { title: "打开 Markdown", properties: ["openFile"], filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] }); if (picked.canceled || !picked.filePaths[0]) return { canceled: true }; path = picked.filePaths[0]; await grant(dirname(path)); }
      if (!path) throw new Error("未选择 Markdown 文件"); path = await allowed(path); const info = await stat(path); if (info.size > 4_000_000) throw new Error("笔记文件超过 4 MB");
      return { path, markdown: await readFile(path, "utf8"), revision: info.mtimeMs };
    }
    if (request.action === "image") {
      const src = request.src ?? ""; if (/^https:\/\//.test(src)) return downloadImage(src);
      if (!request.path || /^(?:[a-z]+:|\/)/i.test(src)) throw new Error("相对图片需要先打开本地 Markdown 文件");
      const path = await allowed(resolve(dirname(request.path), decodeURIComponent(src))), info = await stat(path), mime = mimeFor(path);
      if (!mime || info.size > MAX_IMAGE) throw new Error("图片格式或大小不受支持"); return { mime, base64: (await readFile(path)).toString("base64") };
    }
    const format = request.action === "save" || request.action === "assets" ? "md" : request.format ?? "md";
    let path = request.action === "save" || request.action === "assets" ? request.path : undefined;
    if (request.action === "assets" && !path) throw new Error("请先保存本地 Markdown，再整理图片资源");
    if (path) { path = await allowed(path); if (request.revision !== undefined && (await stat(path)).mtimeMs !== request.revision) throw new Error("本地文件已在其他应用中修改，请重新打开后再保存"); }
    else { const picked = await dialog.showSaveDialog(window, { title: request.action === "save" ? "保存 Markdown" : "导出笔记", defaultPath: `${(request.title || "笔记").replace(/[\\/:*?"<>|]/g, "-")}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] }); if (picked.canceled || !picked.filePath) return { canceled: true }; path = picked.filePath; await grant(dirname(path)); }
    let markdown = request.markdown ?? ""; const images = new Map((request.images ?? []).map(image => [image.src, `data:${image.mime};base64,${image.base64}`]));
    if ([...(request.images ?? [])].reduce((sum, image) => sum + image.base64.length, 0) > 80_000_000) throw new Error("图片资源总量超过 60 MB，请分批导出");
    if (format === "md") { let assetsPath = join(dirname(path), `${basename(path, extname(path))}.assets`);
      if (request.action === "assets") { const picked = await dialog.showOpenDialog(window, { title: "选择笔记图片资源目录", defaultPath: dirname(path), properties: ["openDirectory", "createDirectory"] }); if (picked.canceled || !picked.filePaths[0]) return { canceled: true }; assetsPath = picked.filePaths[0]; await grant(assetsPath); }
      const replacements = new Map<string, string>();
      if (request.images?.length) { await mkdir(assetsPath, { recursive: true }); await allowed(assetsPath, true); }
      for (const image of request.images ?? []) { const bytes = Buffer.from(image.base64, "base64"), name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}.${image.mime.split("/")[1]}`;
        if (request.action === "save" && request.path && !/^(?:[a-z]+:|\/)/i.test(image.src)) { await allowed(resolve(dirname(path), decodeURIComponent(image.src))); continue; }
        await writeFile(await allowed(join(assetsPath, name)), bytes); replacements.set(image.src, relative(dirname(path), join(assetsPath, name)).split(sep).map(encodeURIComponent).join("/")); }
      markdown = rewriteNoteImagePaths(markdown, replacements); await atomicNoteWrite(path, markdown);
    } else if (format === "docx") { for (const [src, data] of images) { if (data.startsWith("data:image/webp;")) { const image = nativeImage.createFromDataURL(data); if (image.isEmpty()) throw new Error("WebP 图片无法转换为 Word 图片"); images.set(src, `data:image/png;base64,${image.toPNG().toString("base64")}`); } } await atomicNoteWrite(path, await noteExportDocx(request.title || "笔记", markdown, images)); }
    else { const html = noteExportHtml(request.title || "笔记", markdown, images, await katexExportCss());
      if (format === "html") await atomicNoteWrite(path, html);
      else { const paper = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `note-export-${window.id}-${Date.now()}` } });
        try { paper.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
          await paper.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); const pdf = await paper.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 } }); await atomicNoteWrite(path, pdf);
        } finally { paper.destroy(); } }
    }
    return { path, markdown, revision: (await stat(path)).mtimeMs };
  }, noteWritingResultSchema);
}
