/**
 * 系统文件关联的落点（2026-11）。
 *
 * 双击 `.md` 时操作系统只交给我们一条路径；这里把它变成一批**可投递**的文件身份，
 * 再交给渲染层的「本地稿纸」。正文不在这里读：渲染层走既有的 `noteWriting.read`，
 * 那条路已经有授权目录、大小上限与编码处理，不必为文件关联再开第二个读盘口。
 *
 * 三条进入路径都要收：macOS 的 `open-file`（含启动前）、Windows/Linux 的 argv、
 * 以及第二个实例转交的 argv。它们最终都落到 `OpenedFileBroker.receive`。
 */
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, dirname, isAbsolute, relative, resolve, sep, basename } from "node:path";
import { shell, type BrowserWindow } from "electron";
import { z } from "zod";
import {
  DESKTOP_IPC_CHANNELS,
  OPENED_FILE_BATCH_MAX_FILES,
  openedFileBatchV1Schema,
  openedFilePrepareImportRequestV1Schema,
  openedFilePrepareImportResultV1Schema,
  openedFileRevealRequestV1Schema,
  openedFileRevealResultV1Schema,
  requestMetaSchema,
  type OpenedFileBatchV1,
  type OpenedFileV1,
} from "@astella/shared/desktop-ipc-contracts";
import { TRANSFER_BATCH_MAX_BYTES } from "@astella/shared/object-transfer-contracts";
import { SOURCE_IMAGE_MAX_BYTES, sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import {
  downloadImage,
  isNoteWritingPathGranted,
  markdownImageSources,
  rewriteNoteImagePaths,
} from "./note-writing-files";
import * as ns_source from "../gateway/desktop-gateway-ns-source";
import type { RestChannelDeps } from "../ipc/desktop-ipc-rest";

/** 只认这几种后缀：这是产品声明的「Markdown 文档」，不是所有文本文件都来抢默认打开。 */
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

/** 一次 prepareImport 最多处理多少张图：与带图导入同一量级，防止一篇奇怪的正文把内存打满。 */
const MAX_PREPARE_IMAGES = 100;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

const byteLengthOf = (text: string) => Buffer.byteLength(text, "utf8");
const megabytes = (value: number) => Math.round(value / 1024 / 1024);

export type OpenedFileIssue = { readonly src: string; readonly message: string };

export function isMarkdownFileName(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(name).toLowerCase());
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 从 argv 里挑出「确实存在、确实是 Markdown 文件」的那些路径。
 *
 * argv 里同时混着 Electron 自己的开关、开发模式的入口脚本和用户双击的那份文件；
 * 只有最后一种能通过这一道。相对路径按启动时的工作目录算（Windows 的
 * 「发送到」与命令行启动都会出现这种形状）。
 */
export async function openedMarkdownPathsFromArgv(
  argv: readonly string[],
  cwd: string,
  options: { readonly exists?: (path: string) => Promise<boolean> } = {},
): Promise<string[]> {
  const exists = options.exists ?? (async (path: string) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  });
  const found: string[] = [];
  for (const arg of argv) {
    const value = arg.trim().replace(/^"(.*)"$/, "$1");
    if (!value || value.startsWith("-") || !isMarkdownFileName(value)) continue;
    const absolute = isAbsolute(value) ? value : resolve(cwd, value);
    if (!(await exists(absolute))) continue;
    found.push(absolute);
  }
  return found;
}

/** 一份磁盘上真的存在的 Markdown；读不出来就返回 null，不给渲染层一条死路径。 */
export async function openedFileIdentity(path: string): Promise<OpenedFileV1 | null> {
  let canonical: string;
  let info;
  try {
    canonical = await realpath(path);
    info = await stat(canonical);
  } catch {
    return null;
  }
  if (!info.isFile() || !isMarkdownFileName(canonical)) return null;
  return {
    version: 1,
    id: randomUUID(),
    path: canonical,
    name: basename(canonical),
    size: info.size,
    modifiedAt: info.mtimeMs,
  };
}

export function openedFileBatch(files: readonly OpenedFileV1[]): OpenedFileBatchV1 {
  return { version: 1, batchId: randomUUID(), files: [...files] };
}

/**
 * 主进程这一侧唯一那份「主进程收到了哪些文件」的状态。
 *
 * 渲染层还没挂载时先攒着：`take` 是首帧补读，也是"渲染层已经准备好接推送"的声明。
 * 在它之前只进 pending，之后每次 `receive` 都直接推给窗口——这样不会出现
 * "双击发生在启动动画之前，文件被丢在地上"。
 */
export class OpenedFileBroker {
  private window: BrowserWindow | null = null;
  private readonly pending: OpenedFileV1[] = [];
  private ready = false;
  private readonly deliver: (window: BrowserWindow, batch: OpenedFileBatchV1) => void | Promise<void>;

  constructor(deliver: (window: BrowserWindow, batch: OpenedFileBatchV1) => void | Promise<void>) {
    this.deliver = deliver;
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
  }

  /** 系统交来的路径：去重、截断、交给窗口；窗口没就绪就等 `take`。 */
  async receive(paths: readonly string[]): Promise<void> {
    const before = this.pending.length;
    for (const path of paths) {
      if (this.pending.length >= OPENED_FILE_BATCH_MAX_FILES) break;
      const identity = await openedFileIdentity(path);
      if (!identity) continue;
      if (this.pending.some((file) => file.path === identity.path)) continue;
      this.pending.push(identity);
    }
    if (this.pending.length === before) return;

    const window = this.window;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    if (!this.ready) return;
    await this.flush();
  }

  /** 渲染层挂载后调一次：把启动期间攒下的文件交给它，并允许后续推送。 */
  async take(window: BrowserWindow): Promise<OpenedFileBatchV1 | null> {
    this.window = window;
    this.ready = true;
    return this.flush();
  }

  private async flush(): Promise<OpenedFileBatchV1 | null> {
    const window = this.window;
    if (!window || window.isDestroyed() || this.pending.length === 0) return null;
    const batch = openedFileBatch(this.pending.splice(0));
    // 先等授权落表再交出路径：渲染层拿到批次就会立刻 read，授权晚一步就会撞上
    // 「请先通过文件选择器打开这个目录」。
    await this.deliver(window, batch);
    return batch;
  }
}

/**
 * 把正文里指向本机的图片读出来、传进对象存储，再把引用换成站内地址。
 *
 * 与带图导入共用同一条上传用途：图片落 `{ws}/imports/{userId}/…`，既不是某篇
 * 笔记的资产，也不要求先有来源——这一步发生时两样都还没建。
 */
export async function prepareOpenedFileImport(
  transport: Parameters<typeof ns_source.uploadBundleImage>[0],
  window: BrowserWindow,
  request: { readonly path: string; readonly markdown: string },
  requestId?: string,
): Promise<{ markdown: string; uploaded: number; issues: OpenedFileIssue[] }> {
  if (!(await isNoteWritingPathGranted(window, request.path))) {
    throw new Error("这个文件不是通过系统打开或文件选择器交进来的，不能读取它旁边的图片。");
  }
  const root = dirname(await realpath(request.path));
  const issues: OpenedFileIssue[] = [];
  const failures = new Map<string, string>();
  const replacements = new Map<string, string>();
  const sources = markdownImageSources(request.markdown);
  let uploaded = 0;
  let bytesUsed = 0;

  const queue: string[] = [];
  for (const src of sources) {
    if (sourceImageObjectKeyFromUrl(src)) continue;
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      issues.push({ src, message: "图片是临时或内嵌地址，请先另存到文件旁边再导入。" });
      continue;
    }
    if (/^http:\/\//i.test(src)) {
      issues.push({ src, message: "这是 http 明文地址，这台机器不出去抓：把图片放进文件旁边，或换成 https。" });
      continue;
    }
    if (/^https:\/\//i.test(src)) { queue.push(src); continue; }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(src)) {
      issues.push({ src, message: "这个地址不是本机文件旁边的相对路径，无法随正文一起收进来。" });
      continue;
    }
    queue.push(src);
  }

  const resolved = (src: string): string | null => {
    const bare = src.split("#")[0]!.split("?")[0]!.replace(/\\/g, "/");
    if (!bare) return null;
    let decoded = bare;
    try { decoded = decodeURIComponent(bare); } catch { /* 原样使用 */ }
    const candidate = resolve(root, decoded.startsWith("/") ? decoded.slice(1) : decoded);
    return isWithin(root, candidate) ? candidate : null;
  };

  for (const src of queue.slice(0, MAX_PREPARE_IMAGES)) {
    try {
      let bytes: Buffer;
      let fileName: string;
      let mime: string;
      if (/^https:\/\//i.test(src)) {
        const fetched = await downloadImage(src, 0, SOURCE_IMAGE_MAX_BYTES);
        bytes = Buffer.from(fetched.base64, "base64");
        mime = fetched.mime;
        fileName = basename(new URL(src).pathname) || "image";
      } else {
        const path = resolved(src);
        if (!path) { failures.set(src, "这个路径不在文件所在的文件夹里，没有读。"); continue; }
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) { failures.set(src, `找不到 ${src}：核对文件名，或把图片放到正文旁边。`); continue; }
        mime = IMAGE_MIME_BY_EXT[extname(path).toLowerCase()] ?? "";
        if (!mime) { failures.set(src, `${basename(path)} 不是 PNG / JPEG / GIF / WebP。`); continue; }
        if (info.size === 0) { failures.set(src, `${basename(path)} 是个空文件。`); continue; }
        if (info.size > SOURCE_IMAGE_MAX_BYTES) {
          failures.set(src, `${basename(path)} 有 ${megabytes(info.size)} MB，超过笔记里显示得动的 ${megabytes(SOURCE_IMAGE_MAX_BYTES)} MB。`);
          continue;
        }
        bytes = await readFile(path);
        fileName = basename(path);
      }
      if (bytes.byteLength > SOURCE_IMAGE_MAX_BYTES) {
        failures.set(src, `这张图有 ${megabytes(bytes.byteLength)} MB，超过笔记里显示得动的 ${megabytes(SOURCE_IMAGE_MAX_BYTES)} MB。`);
        continue;
      }
      if (bytesUsed + bytes.byteLength > TRANSFER_BATCH_MAX_BYTES) {
        failures.set(src, `到这里累计图片已超过约 ${megabytes(TRANSFER_BATCH_MAX_BYTES)} MB，这张没有上传。`);
        continue;
      }
      bytesUsed += bytes.byteLength;
      replacements.set(src, await ns_source.uploadBundleImage(transport, { fileName, mimeType: mime, bytes }, requestId));
      uploaded += 1;
    } catch (error) {
      failures.set(src, error instanceof Error && error.message ? error.message : "这张图没能传上去。");
    }
  }
  if (queue.length > MAX_PREPARE_IMAGES) {
    issues.push({ src: "其余图片", message: `一次最多带 ${MAX_PREPARE_IMAGES} 张图，后面的 ${queue.length - MAX_PREPARE_IMAGES} 张没有处理。` });
  }
  for (const [src, message] of failures) issues.push({ src, message });

  const markdown = replacements.size > 0 ? rewriteNoteImagePaths(request.markdown, replacements) : request.markdown;
  if (byteLengthOf(markdown) > 10_000_000) {
    throw new Error(`改写之后正文约 ${megabytes(byteLengthOf(markdown))} MB，超过单份正文上限。`);
  }
  return { markdown, uploaded, issues };
}

/**
 * 系统文件关联的 IPC。`take` 不做路由门控：它只把主进程刚收下的几条路径交回去；
 * `prepareImport` 才动网络，因此与带图导入同一道 M2 门（source.library）。
 */
export function registerOpenedFileChannels(
  deps: Pick<RestChannelDeps, "channel" | "requireM2Route" | "assertEpoch" | "contract" | "gateway" | "getActiveWorkspaceEpoch">,
  broker: OpenedFileBroker,
): void {
  deps.channel(
    DESKTOP_IPC_CHANNELS.openedFileTake,
    z.strictObject({ meta: requestMetaSchema }),
    (_event, window) => broker.take(window),
    openedFileBatchV1Schema.nullable(),
  );

  deps.channel(
    DESKTOP_IPC_CHANNELS.openedFilePrepareImport,
    z.strictObject({ meta: requestMetaSchema, request: openedFilePrepareImportRequestV1Schema }),
    async (_event, window, input) => {
      deps.requireM2Route(deps.contract, "source.library");
      deps.assertEpoch(input.meta, deps.getActiveWorkspaceEpoch());
      const result = await prepareOpenedFileImport(
        deps.gateway.gatewayTransport,
        window,
        input.request,
        input.meta.requestId,
      );
      return { version: 1 as const, ...result };
    },
    openedFilePrepareImportResultV1Schema,
  );

  deps.channel(
    DESKTOP_IPC_CHANNELS.openedFileReveal,
    z.strictObject({ meta: requestMetaSchema, request: openedFileRevealRequestV1Schema }),
    async (_event, window, input) => {
      const granted = await isNoteWritingPathGranted(window, input.request.path);
      if (granted) shell.showItemInFolder(input.request.path);
      return { version: 1 as const, revealed: granted };
    },
    openedFileRevealResultV1Schema,
  );
}

export const openedFileTestables = {
  openedMarkdownPathsFromArgv,
  openedFileIdentity,
  prepareOpenedFileImport,
  isMarkdownFileName,
  isWithin,
};
