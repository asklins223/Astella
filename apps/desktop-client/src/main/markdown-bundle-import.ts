import { unzipSync } from "fflate";
/**
 * 带图导入一整个 Markdown 包（文件夹或 zip）。
 *
 * ## 为什么要有这一条
 *
 * 采集通道一次只读一份文件：正文里 `![](./img/a.png)` 这样的兄弟图片没人管，到了服务端
 * 就是一串死引用（`extractObjectKeyFromMarkdownImage` 只认站内前缀），建完笔记图上就是空的。
 * 外链同理——渲染层的请求闸不放行外部地址，在这条之前那些图**一张都显示不出来**。
 *
 * ## 为什么在这台机器上做
 *
 * 包在读者本地，服务端拿不到 `./img/a.png` 指向的那些字节。所以在主进程：读包 → 把图片传进
 * 对象存储 → 把正文里的引用换成站内地址。交回渲染层的只是**几份改写好的正文**，建来源、
 * 解析、建笔记一条都不新（还是 `source.create` 那条老路）。
 *
 * 图片走 `markdown_import_image` 用途，落 `{ws}/imports/{userId}/{uuid}.{ext}`：这一刻还没有
 * 笔记，而 `notes/` 那个形状在下载路由上硬要求资产已回填所属笔记——借它的话图存得下、取不回。
 *
 * ## 为什么分「先看一眼」与「真的传」两步
 *
 * 一个包可能几百张图。一步做完，选错文件夹的代价就是白等一轮几百次上传。所以 `inspect`
 * 只读盘、只算不传，先把「42 篇、180 张图、6 张找不到」说清楚；读者点头之后 `import` 才动网络。
 *
 * ## 边界都是报出去的，不是静默跳过的
 *
 * `http:` 明文外链、包外绝对路径、五种以外的格式、单张超过渲染层
 * 取得动的那个体积、zip 里因超限没解开的条目——各带一句原因回到界面上点名。
 */
import { dirname, extname, join, posix, relative, sep } from "node:path";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dialog, type BrowserWindow } from "electron";
import {
  DESKTOP_IPC_CHANNELS,
  MARKDOWN_BUNDLE_MAX_FILES,
  markdownBundleActionSchema,
  markdownBundleResultV1Schema,
  type MarkdownBundleImageIssueV1,
  type MarkdownBundleKind,
  type MarkdownBundlePreviewV1,
  type MarkdownBundleResultV1,
  type MarkdownBundleTaskV1,
} from "@astella/shared/desktop-ipc-contracts";
import { MAX_SOURCE_TEXT_BYTES } from "@astella/shared/object-transfer-contracts";
import { sourceImageObjectKeyFromUrl, SOURCE_IMAGE_MAX_BYTES } from "@astella/shared/source-image-contracts";
import { noteMarkdownSyntax } from "@astella/shared/note-markdown";
import { downloadImage, markdownImageSources, rewriteNoteImagePaths } from "./note-writing-files";
import * as ns_source from "./desktop-gateway-ns-source";
import type { GatewayTransport } from "./desktop-gateway-transport";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import type { RestChannelDeps } from "./desktop-ipc-rest";

/** 索引多少个文件就停：再深的目录树也得有个止境。 */
const MAX_BUNDLE_ENTRIES = 5_000;
const MAX_BUNDLE_DEPTH = 5;
/** 这些目录不是读者的笔记，翻它们只会把索引挤满。 */
const IGNORED_SEGMENTS = new Set([".git", "node_modules", "__MACOSX"]);
/** zip 是整份进内存才解得开的，所以它比文件夹多两道闸。 */
const MAX_ZIP_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = MAX_SOURCE_TEXT_BYTES;
const MAX_BUNDLE_IMAGES = 600;
const MAX_BUNDLE_IMAGE_BYTES = 120 * 1024 * 1024;
/** 一次回给渲染层的正文总量：几百份各几 MB 会把这一次 IPC 撑成几百 MB。 */
const MAX_BUNDLE_BODY_BYTES = 50 * 1024 * 1024;
/** 与对象存储那侧的镜像下载、服务端预注册同一个数：两边都不打满。 */
const UPLOAD_CONCURRENCY = 4;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

const byteLengthOf = (text: string) => Buffer.byteLength(text, "utf8");
const megabytes = (value: number) => Math.round(value / 1024 / 1024);
const issue = (src: string, message: string): MarkdownBundleImageIssueV1 => ({ src: src.slice(0, 2_000), message: message.slice(0, 480) });
/** 包内路径一律以 posix 分隔符记账，正文里的引用也是——两边同一套写法才对得上。 */
const toPosix = (value: string) => value.split(sep).join("/");
const isIgnored = (inner: string) => inner.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));

type BundleReader = {
  /** 包内可读文件：posix 相对路径 → 字节数。 */
  readonly entries: ReadonlyMap<string, number>;
  /** 小写 → 真名。包从 Windows 或网盘里出来时，引用与文件名常常差一位大小写。 */
  readonly lower: ReadonlyMap<string, string>;
  /** 看得见但故意没取回来的那些（原因要说得出，不能推给「找不到文件」）。 */
  readonly skipped: ReadonlyMap<string, string>;
  read(path: string): Promise<Buffer>;
};

function index(entries: Map<string, number>): BundleReader["lower"] {
  const lower = new Map<string, string>();
  for (const name of entries.keys()) {
    const key = name.toLowerCase();
    // 同一目录里同时有 Readme.md 与 readme.md 时（大小写敏感的文件系统允许），保留第一个，
    // 后面那条就按「找不到」如实报，而不是猜一个读者没写的那个。
    if (!lower.has(key)) lower.set(key, name);
  }
  return lower;
}

/** zip 条目名不可信：带 `..`、绝对路径、盘符、反斜杠的都不算这个包的文件。 */
function isSafeEntry(name: string): boolean {
  return !name.startsWith("/") && !name.includes("\\") && !/^[a-zA-Z]:/.test(name)
    && !name.split("/").includes("..") && !posix.basename(name).startsWith("._") && posix.basename(name) !== ".DS_Store";
}

async function readFolderBundle(root: string): Promise<BundleReader> {
  root = await realpath(root);
  const entries = new Map<string, number>();
  const scan = async (directory: string, depth: number): Promise<void> => {
    if (entries.size >= MAX_BUNDLE_ENTRIES || depth > MAX_BUNDLE_DEPTH) return;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (entries.size >= MAX_BUNDLE_ENTRIES) return;
      const full = join(directory, item.name);
      const inner = toPosix(relative(root, full));
      // 符号链接既不是 isFile() 也不是 isDirectory()，于是天然被跳过——这正是想要的：
      // 一个指向包外的链接，不该把「包里的文件」变成「任何人想让这台机器读的文件」。
      if (item.isDirectory()) { if (!isIgnored(inner)) await scan(full, depth + 1); }
      else if (item.isFile() && !item.name.startsWith(".") && !isIgnored(inner)) {
        entries.set(inner, (await stat(full)).size);
      }
    }
  };
  await scan(root, 0);
  return { entries, lower: index(entries), skipped: new Map(), read: async (path) => {
    const canonical = await realpath(join(root, ...path.split("/")));
    const inner = relative(root, canonical);
    if (inner === ".." || inner.startsWith(`..${sep}`)) throw new Error("图片路径通过符号链接离开了所选文件夹。");
    if ((await stat(canonical)).size > MAX_ZIP_ENTRY_BYTES) throw new Error("文件超过 10 MB，请拆分后导入。");
    return readFile(canonical);
  } };
}

async function readZipBundle(path: string): Promise<BundleReader> {
  if ((await stat(path)).size > MAX_ZIP_BYTES) throw new Error("这个 zip 超过 120 MB，请拆分后导入。");
  const raw = await readFile(path);
  if (raw.byteLength > MAX_ZIP_BYTES) {
    throw new Error(`这个 zip 有 ${megabytes(raw.byteLength)} MB，超过一次能解开的 ${megabytes(MAX_ZIP_BYTES)} MB，请拆开几份再导入。`);
  }
  const skipped = new Map<string, string>();
  let kept = 0, uncompressedBytes = 0;
  // filter 挡在解压之前：一个自称要解压成 4 GB 的条目不该真的被解出来，包内条目过多时也别继续解。
  const unzipped = unzipSync(new Uint8Array(raw), {
    filter: (file) => {
      const name = file.name;
      if (name.endsWith("/") || !isSafeEntry(name) || isIgnored(name)) return false;
      if (file.size > MAX_ZIP_ENTRY_BYTES) { skipped.set(name, `它在 zip 里有 ${megabytes(file.size)} MB，超过单个文件 ${megabytes(MAX_ZIP_ENTRY_BYTES)} MB 的取回上限。`); return false; }
      if (kept >= MAX_BUNDLE_ENTRIES) { skipped.set(name, `这个包里的文件超过 ${MAX_BUNDLE_ENTRIES} 个，这一个没有被取回来。`); return false; }
      if (uncompressedBytes + file.size > MAX_BUNDLE_IMAGE_BYTES) { skipped.set(name, "包解压后累计超过 120 MB，请拆分后导入。"); return false; }
      uncompressedBytes += file.size;
      kept += 1;
      return true;
    },
  });
  const bodies = new Map<string, Buffer>();
  const entries = new Map<string, number>();
  for (const [name, bytes] of Object.entries(unzipped)) {
    const file = Buffer.from(bytes as Uint8Array);
    entries.set(name, file.byteLength);
    bodies.set(name, file);
  }
  return { entries, lower: index(entries), skipped, read: async (inner) => bodies.get(inner) ?? Buffer.alloc(0) };
}

/**
 * 一条引用可能指向包里的哪个位置。
 *
 * `- `/img/a.png` 这种「根相对」是 Obsidian 与静态站导出的常见写法，它的根就是这个包；
 *  - 其余按这份正文所在的目录算；
 *  - 文件名带空格时正文里常写成 `%20`，反过来文件名字面就带 `%20` 的也有，两种都摆出来。
 */
function candidatePaths(file: string, src: string): string[] {
  const bare = src.split("#")[0]!.split("?")[0]!.replace(/\\/g, "/");
  if (!bare || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(bare) || !extname(bare)) return [];
  if (bare.startsWith("/")) return [decodeSafely(bare.slice(1)), bare.slice(1)];
  const joined = posix.normalize(posix.join(posix.dirname(file), bare));
  const decoded = decodeSafely(joined);
  return decoded === joined ? [joined] : [decoded, joined];
}

function decodeSafely(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** 命中索引才算这个包里的文件：解析结果如果不是刚扫到的那一个条目，就什么都读不到。 */
function locate(reader: BundleReader, file: string, src: string) {
  for (const candidate of candidatePaths(file, src)) {
    if (candidate.startsWith("../") || candidate === "." || posix.isAbsolute(candidate)) continue;
    if (reader.entries.has(candidate)) return { path: candidate };
    const byCase = reader.lower.get(candidate.toLowerCase());
    if (byCase) return { path: byCase };
    const reason = reader.skipped.get(candidate) ?? (byCase ? reader.skipped.get(byCase) : undefined);
    if (reason) return { skipped: reason };
  }
  return {};
}

type PlannedRef =
  | { readonly kind: "local"; readonly src: string; readonly path: string }
  | { readonly kind: "remote"; readonly src: string }
  | { readonly kind: "blocked"; readonly src: string; readonly message: string };

function planFileReferences(file: string, markdown: string, reader: BundleReader): PlannedRef[] {
  const plans: PlannedRef[] = [];
  for (const src of markdownImageSources(markdown)) {
    if (sourceImageObjectKeyFromUrl(src)) continue;
    if (src.startsWith("data:") || src.startsWith("blob:")) { plans.push({ kind: "blocked", src, message: "图片是临时或内嵌地址，请把它另存到包里的图片文件夹后导入。" }); continue; }
    if (/^https:\/\//i.test(src)) { plans.push({ kind: "remote", src }); continue; }
    if (/^http:\/\//i.test(src)) { plans.push({ kind: "blocked", src, message: "这是 http 明文地址，这台机器不出去抓：把这篇里的链接换成 https，或者把图片放进这个包。" }); continue; }
    const { path, skipped } = locate(reader, file, src);
    if (skipped) { plans.push({ kind: "blocked", src, message: skipped }); continue; }
    if (!path) {
      plans.push({ kind: "blocked", src, message: /^(?:\/|[a-zA-Z]:[\\/])/.test(src)
        ? `这是包外面的绝对路径（${src}），这一版只读这个包里的文件：把图片放进这个文件夹再导入。`
        : `在这个包里找不到 ${src}：核对一下文件名，或把图片放到这篇正文旁边。` });
      continue;
    }
    const mime = IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
    if (!mime) { plans.push({ kind: "blocked", src, message: `${path} 是 .${extname(path).slice(1)}，笔记里只显示 PNG / JPEG / GIF / WebP。` }); continue; }
    const size = reader.entries.get(path) ?? 0;
    if (size === 0) { plans.push({ kind: "blocked", src, message: `${path} 是个空文件。` }); continue; }
    if (size > SOURCE_IMAGE_MAX_BYTES) {
      plans.push({ kind: "blocked", src, message: `${path} 有 ${megabytes(size)} MB，超过笔记里显示得动的 ${megabytes(SOURCE_IMAGE_MAX_BYTES)} MB，先在原程序里压缩再导入。` });
      continue;
    }
    plans.push({ kind: "local", src, path });
  }
  return plans;
}

type PlannedFile = { readonly name: string; readonly markdown: string; readonly refs: PlannedRef[] };
type PlannedBundle = {
  readonly files: PlannedFile[];
  readonly overflow: number;
  readonly issues: MarkdownBundleImageIssueV1[];
  /** 去重之后要上传的本地图。 */
  readonly locals: string[];
  /** 去重之后要出去抓的外链。 */
  readonly remotes: string[];
};

/** 读盘 + 归类，一次网络都不发：两步共用它，才不会对同一个包说两种话。 */
async function planBundle(reader: BundleReader): Promise<PlannedBundle> {
  const markdownFiles = [...reader.entries.keys()]
    .filter((name) => /\.(md|markdown)$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  const issues: MarkdownBundleImageIssueV1[] = [];
  const files: PlannedFile[] = [];
  let bytes = 0;
  for (const name of markdownFiles.slice(0, MARKDOWN_BUNDLE_MAX_FILES)) {
    if (bytes >= MAX_BUNDLE_BODY_BYTES) break;
    const size = reader.entries.get(name) ?? 0;
    if (size > MAX_SOURCE_TEXT_BYTES) { issues.push(issue(name, `这份正文有 ${megabytes(size)} MB，超过单份正文的 ${megabytes(MAX_SOURCE_TEXT_BYTES)} MB 上限。`)); continue; }
    const markdown = (await reader.read(name)).toString("utf8").replace(/^﻿/, "");
    if (!markdown.trim()) { issues.push(issue(name, "这份文件是空的，没有可收的内容。")); continue; }
    if (bytes + byteLengthOf(markdown) > MAX_BUNDLE_BODY_BYTES) {
      issues.push(issue(name, `到这里累计正文已超过约 ${megabytes(MAX_BUNDLE_BODY_BYTES)} MB，这一轮先收到这里，剩下的分下一次再导。`));
      break;
    }
    bytes += byteLengthOf(markdown);
    files.push({ name, markdown, refs: planFileReferences(name, markdown, reader) });
  }
  const locals = [...new Set(files.flatMap((file) => file.refs.flatMap((ref) => ref.kind === "local" ? [ref.path] : [])))];
  const remotes = [...new Set(files.flatMap((file) => file.refs.flatMap((ref) => ref.kind === "remote" ? [ref.src] : [])))];
  for (const file of files) {
    for (const ref of file.refs) if (ref.kind === "blocked") issues.push(issue(ref.src, ref.message));
  }
  return { files, overflow: Math.max(0, markdownFiles.length - MARKDOWN_BUNDLE_MAX_FILES), issues, locals, remotes };
}

/** 一条待传的图：本地按包内路径认，外链按那串地址认。`mime` 以外链回来那个为准。 */
type PendingImage = { readonly key: string; readonly src: string; readonly fileName: string; readonly path?: string; mime: string };

function pendingImages(plan: PlannedBundle): { readonly list: PendingImage[]; readonly overflow: number } {
  const list: PendingImage[] = plan.locals.map((path) => ({
    key: `local:${path}`, src: path, path, fileName: posix.basename(path), mime: IMAGE_MIME_BY_EXT[extname(path).toLowerCase()]!,
  }));
  for (const src of plan.remotes) {
    let name = "";
    try { name = posix.basename(new URL(src).pathname); } catch { name = ""; }
    list.push({ key: `remote:${src}`, src, fileName: name || "image", mime: "" });
  }
  return { list: list.slice(0, MAX_BUNDLE_IMAGES), overflow: Math.max(0, list.length - MAX_BUNDLE_IMAGES) };
}

/** 有界并发池：几百张图不该变成几百次串行往返，也不该一次打满对象存储。 */
async function mapBounded<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]!); }
  }));
  return results;
}

/** 失败要说得下一步做什么：状态码是服务端给的，别翻译成一句「失败了」。 */
function reasonForUploadFailure(error: unknown): string {
  if (error instanceof DesktopGatewayFailure) {
    if (error.code === "cancelled") return "换了空间或账号，这一批的上传停了。";
    if (error.httpStatus === 413) return `这张图超过笔记里显示得动的 ${megabytes(SOURCE_IMAGE_MAX_BYTES)} MB，先压缩再导入。`;
    if (error.httpStatus === 415) return "这张图的内容和它声明的格式对不上（常见于把 .webp 改名成 .jpg），换回原格式再导入。";
    if (error.httpStatus === 429) return "传得太频繁，等一分钟再导这一批。";
    if (error.code === "api_unavailable" || error.code === "api_untrusted") return "连不上服务，这张图没能传上去：检查网络，或稍后单独再导这一篇。";
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("MB")) return message;
  if (message.includes("本机或内部网络")) return "这个图片地址指向本机或内部网络，这台机器不出去抓。";
  if (message.includes("仅支持公开 HTTPS")) return "这个地址不是公开 HTTPS，不出去抓：把图片存进这个包再导入。";
  if (message.includes("未返回支持的图片")) return "这个地址回来的不是 PNG / JPEG / GIF / WebP：把图片存进这个包再导入。";
  return "这张图没能传上去，可以稍后单独再导这一篇。";
}

async function localizeImages(transport: GatewayTransport, reader: BundleReader, plan: PlannedBundle, requestId?: string, assertCurrent: () => void = () => {}) {
  const { list, overflow } = pendingImages(plan);
  const urls = new Map<string, string>();
  const failures = new Map<string, string>();
  if (overflow > 0) failures.set("这个包", `这里要传的图一共 ${list.length + overflow} 张，一次最多 ${MAX_BUNDLE_IMAGES} 张，多出的 ${overflow} 张没传。`);
  let bytesUsed = 0;
  let uploaded = 0;
  await mapBounded(list, async (item) => {
    assertCurrent();
    if (bytesUsed > MAX_BUNDLE_IMAGE_BYTES) { failures.set(item.src, `到这里累计图片已超过约 ${megabytes(MAX_BUNDLE_IMAGE_BYTES)} MB，剩下的没传。`); return; }
    let bytes: Buffer;
    try {
      if (item.path) bytes = await reader.read(item.path);
      else {
        const fetched = await downloadImage(item.src, 0, SOURCE_IMAGE_MAX_BYTES);
        bytes = Buffer.from(fetched.base64, "base64");
        // 外链那张图是什么格式，以服务器回的 content-type 为准，不看地址尾巴。
        item.mime = fetched.mime;
      }
    } catch (error) {
      failures.set(item.src, reasonForUploadFailure(error));
      return;
    }
    if (bytes.byteLength > SOURCE_IMAGE_MAX_BYTES) {
      failures.set(item.src, `这张图有 ${megabytes(bytes.byteLength)} MB，超过笔记里显示得动的 ${megabytes(SOURCE_IMAGE_MAX_BYTES)} MB。`);
      return;
    }
    if (bytesUsed + bytes.byteLength > MAX_BUNDLE_IMAGE_BYTES) { failures.set(item.src, "图片累计超过 120 MB，这张没有上传。"); return; }
    bytesUsed += bytes.byteLength;
    assertCurrent();
    try {
      urls.set(item.key, await ns_source.uploadBundleImage(transport, { fileName: item.fileName, mimeType: item.mime, bytes }, requestId));
      uploaded += 1;
    } catch (error) {
      failures.set(item.src, reasonForUploadFailure(error));
    }
  });
  return { urls, failures, uploaded };
}

/** 选过的包按窗口记着：`import` 那一步只认这个窗口刚用选择器选过的那个，任意路径换不到读盘权利。 */
const picks = new WeakMap<BrowserWindow, Map<string, MarkdownBundleKind>>();

function grantedPicks(window: BrowserWindow): Map<string, MarkdownBundleKind> {
  const existing = picks.get(window);
  if (existing) return existing;
  const granted = new Map<string, MarkdownBundleKind>();
  window.once("closed", () => picks.delete(window));
  picks.set(window, granted);
  return granted;
}

async function pickBundle(window: BrowserWindow, granted: Map<string, MarkdownBundleKind>, kind: MarkdownBundleKind): Promise<string | null> {
  const picked = kind === "zip"
    ? await dialog.showOpenDialog(window, { title: "导入带图片的 Markdown 包", properties: ["openFile"], filters: [{ name: "Markdown 包（zip）", extensions: ["zip"] }] })
    : await dialog.showOpenDialog(window, { title: "导入带图片的 Markdown 文件夹", properties: ["openDirectory"] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const canonical = await realpath(picked.filePaths[0]);
  const info = await stat(canonical);
  if (kind === "zip" && !info.isFile()) throw new Error("选的不是 zip 文件：要选那个包本身，不要选它所在的文件夹。");
  if (kind === "folder" && !info.isDirectory()) throw new Error("选的不是文件夹。");
  granted.set(canonical, kind);
  return canonical;
}

async function openReader(granted: Map<string, MarkdownBundleKind>, kind: MarkdownBundleKind, bundlePath: string): Promise<BundleReader> {
  const canonical = await realpath(bundlePath).catch(() => "");
  if (!canonical || granted.get(canonical) !== kind) throw new Error("请先用文件选择器选好这个包。");
  return kind === "zip" ? readZipBundle(canonical) : readFolderBundle(canonical);
}

/** 一份数都没有的 preview：取消与读盘失败都回这个形状，界面上只需决定说什么。 */
function blankPreview(overrides: Partial<MarkdownBundlePreviewV1> = {}): MarkdownBundlePreviewV1 {
  return { version: 1, stage: "preview", files: 0, overflow: 0, referenced: 0, localizable: 0, imageBytes: 0, toUpload: 0,
    issues: [], issueOverflow: 0, ...overrides };
}

/** 读盘阶段的失败不抛给通道（那只会得到一句「内部错误」），而是带着原因回到那一屏上。 */
function previewFailure(kind: MarkdownBundleKind, message: string): MarkdownBundleResultV1 {
  return blankPreview({ kind, issues: [issue("这个包", message)] });
}

export function registerMarkdownBundleChannels(deps: Pick<RestChannelDeps,
  "channel" | "requireM2Route" | "assertEpoch" | "contract" | "gateway" | "getActiveWorkspaceEpoch">): void {
  deps.channel(DESKTOP_IPC_CHANNELS.sourceBundleImport, markdownBundleActionSchema, async (_event, window, input): Promise<MarkdownBundleResultV1> => {
    deps.requireM2Route(deps.contract, "source.library");
    deps.assertEpoch(input.meta, deps.getActiveWorkspaceEpoch());
    const request = input.request;
    const granted = grantedPicks(window);
    const transport = deps.gateway.gatewayTransport;
    // 采集是 owner 的写动作：在这里问一次，别让读者等几百张图传完才听到那句「不允许」。
    const capabilities = await ns_source.getCapabilities(transport, input.meta.requestId);
    if (capabilities.actionCapabilities["source.create"] !== "allowed") throw new DesktopGatewayFailure("forbidden", "never");

    const bundlePath = request.action === "inspect"
      ? await pickBundle(window, granted, request.kind)
      : request.bundlePath;
    if (!bundlePath) return blankPreview({ canceled: true });
    let reader: BundleReader;
    let plan: PlannedBundle;
    try {
      reader = await openReader(granted, request.kind, bundlePath);
      plan = await planBundle(reader);
    } catch (error) {
      return previewFailure(request.kind, error instanceof Error && error.message ? error.message : "这个包打不开。");
    }

    if (request.action === "inspect") {
      const { list } = pendingImages(plan);
      let imageBytes = 0;
      for (const item of list) if (item.path) imageBytes += reader.entries.get(item.path) ?? 0;
      const shown = plan.issues.slice(0, 50);
      return {
        version: 1, stage: "preview", kind: request.kind, bundlePath,
        files: plan.files.length, overflow: plan.overflow,
        referenced: plan.files.reduce((sum, file) => sum + file.refs.length, 0),
        localizable: list.length, toUpload: list.length, imageBytes,
        issues: shown, issueOverflow: Math.max(0, plan.issues.length - shown.length),
      };
    }

    const { urls, failures, uploaded } = await localizeImages(transport, reader, plan, input.meta.requestId, () => deps.assertEpoch(input.meta, deps.getActiveWorkspaceEpoch()));
    deps.assertEpoch(input.meta, deps.getActiveWorkspaceEpoch());
    const tasks: MarkdownBundleTaskV1[] = [];
    const dropped: MarkdownBundleImageIssueV1[] = [];
    for (const file of plan.files) {
      const replacements = new Map<string, string>();
      for (const ref of file.refs) {
        const key = ref.kind === "local" ? `local:${ref.path}` : ref.kind === "remote" ? `remote:${ref.src}` : "";
        const target = key ? urls.get(key) : undefined;
        if (target) replacements.set(ref.src, target);
      }
      const content = replacements.size > 0 ? rewriteNoteImagePaths(file.markdown, replacements) : file.markdown;
      if (byteLengthOf(content) > MAX_SOURCE_TEXT_BYTES) {
        dropped.push(issue(file.name, `改写之后正文约 ${megabytes(byteLengthOf(content))} MB，超过单份正文的 ${megabytes(MAX_SOURCE_TEXT_BYTES)} MB 上限，这一篇没有收进来。`));
        continue;
      }
      const title = posix.basename(file.name).replace(/\.[^.]+$/, "");
      tasks.push({ name: file.name, content, ...(title ? { title } : {}) });
    }
    const merged = [...plan.issues, ...[...failures.entries()].map(([src, message]) => issue(src, message))];
    const shown = merged.slice(0, 50);
    return {
      version: 1, stage: "imported", kind: request.kind, tasks, uploaded,
      issues: shown, issueOverflow: Math.max(0, merged.length - shown.length),
      dropped: dropped.slice(0, MARKDOWN_BUNDLE_MAX_FILES),
    };
  }, markdownBundleResultV1Schema);
}

/** 纯函数部分留给测试：路径归属与引用归类是这条路上最容易说错话的地方。 */
export const bundleTestables = { readFolderBundle, readZipBundle, planBundle, isSafeEntry, candidatePaths, locate, planFileReferences, pendingImages, toPosix };
