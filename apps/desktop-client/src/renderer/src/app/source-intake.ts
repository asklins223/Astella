/**
 * 跨页面收录来源的共享地基：剪贴板链接弹窗与全局拖放浮层都走这里。
 *
 * 常量（正文上限、能收录的后缀）原来散在来源库的采集栏里，
 * 抽到这里只有一处真相；事件是外部收录完成后通知来源库刷新索引的窄通道。
 */
import { MAX_SOURCE_TEXT_BYTES } from "@astella/shared/object-transfer-contracts";

export const SOURCE_CAPTURED_EVENT = "astella:source-captured";

export type SourceCapturedDetail = {
  readonly sourceId: string;
  readonly title: string;
};

export function dispatchSourceCaptured(sourceId: string, title: string): void {
  window.dispatchEvent(new CustomEvent<SourceCapturedDetail>(SOURCE_CAPTURED_EVENT, {
    detail: { sourceId, title },
  }));
}

/**
 * 一份正文的上限。数值只有共享合同那一个源：服务端存储用途、没配对象存储时那一发 POST
 * 与 worker 回读用的是同一个数，界面上那句上限跟着它走，不再各写一份。
 */
export const MAX_CAPTURE_BYTES = MAX_SOURCE_TEXT_BYTES;

/** 收录通道能承载的后缀：这些文件本身就是正文，读进来就能收。 */
export const TEXT_FILE_PATTERN = /\.(txt|md|markdown|mdx|json|jsonc|csv|tsv|ya?ml|toml|ini|log|html?|css|scss|less|jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|tex)$/i;

/**
 * 能在本机解析成正文的文档：PDF 取文字层，Word 取它自己声明的段落样式。
 * 解析只发生在这一台机器上，收进来源的仍然是正文——服务端那条链一个字都不用改。
 */
export const DOCUMENT_FILE_PATTERN = /\.(pdf|docx)$/i;
export const PDF_FILE_PATTERN = /\.pdf$/i;

/**
 * 一眼像文档、这一版解析不了的格式，单独列出来只为一件事。
 *
 * `.doc` 与 `.docx` 差一个字母，读者以为已经支持了；拒绝的话必须说得出**下一步做什么**
 * （在 Word 里另存为 .docx），只说「暂不解析」等于把人推回试错。
 */
export const LEGACY_DOCUMENT_FILE_PATTERN = /\.(doc|dot|odt|rtf|wps|pages)$/i;

/**
 * 交给解析器之前的原始文件上限。
 *
 * 它与正文上限是两件事：一份 40MB 的 PDF 里可能只有几十 KB 文字，正文 10MB 的那一份原文
 * 也许只有 2MB。拦原始字节是为了不在本机把一个巨型文件整份读进内存。
 */
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

export const captureBytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 文本文件（.txt / .md / 代码）的解码：先按 UTF-8 **严格**读，读不动才按 GBK 再试一次。
 *
 * 为什么不用 `file.text()`：那一条**不报错**——Windows 记事本的「ANSI」其实就是 GBK，
 * 一份中文 .txt 会被静默解成一串替换字符，收进来源的是坏掉的正文，而界面什么都不会说。
 * 「UTF-8 严格解失败」是一个事实，不是一条猜；换完 GBK 还剩替换字符，就说明这份文件
 * 两种都不是，如实报出来，不把坏字符存进材料。
 */
export function decodeCaptureText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; message: string } {
  const stripBom = (text: string) => (text.startsWith("\uFEFF") ? text.slice(1) : text);
  try {
    return { ok: true, text: stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    // 不是 UTF-8：往下按 GBK 试。
  }
  let gbk: string;
  try {
    gbk = new TextDecoder("gbk").decode(bytes);
  } catch {
    gbk = "";
  }
  if (gbk.includes("\uFFFD")) {
    return { ok: false, message: "这份文本既不是 UTF-8 也不是 GBK 能读出来的编码，先在原文程序里另存为 UTF-8 再拖进来。" };
  }
  return { ok: true, text: stripBom(gbk) };
}

/** Sizes read in bytes until a kilobyte is worth mentioning at all. */
export function formatCaptureSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 10) return `${kilobytes.toFixed(1)} KB`;
  const megabytes = kilobytes / 1024;
  return megabytes < 10 ? `${Math.round(kilobytes)} KB` : `${Math.round(megabytes)} MB`;
}

export function titleFromFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\.[^.]+$/, "") || trimmed;
}

/**
 * 拖放落点是否属于"有人在写字"的地方：输入框、编辑器正文都归它，
 * 全局浮层不跟它们抢——图片进笔记、文字进表单，各走各的旧链路。
 */
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [role='textbox'], .milkdown, .ProseMirror";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(EDITABLE_SELECTOR));
}

/** 来源采集栏拥有自己的文字与文件投放格，全局采集器和伴星都要让路。 */
export function isSourceCaptureTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(".capture-strip, .capture-form"));
}

/** 编辑中的笔记纸面挂这个属性，声明"纯图片的拖放归这一篇正文"。 */
export const NOTE_PAPER_IMAGE_DROP_ATTR = "data-note-paper-image-drop";

/**
 * 整份都是图片才返回文件，混进任何一个别的文件就返回空。
 *
 * 这条判据同时决定两件事：纸面要不要接住这一下，以及全局浮层要不要让路——
 * 两边各写一遍迟早会说出不一致的那句话。
 */
export function imageOnlyFiles(transfer: DataTransfer | null): File[] {
  if (!transfer || transfer.files.length === 0) return [];
  const files = Array.from(transfer.files);
  return files.every((file) => file.type.startsWith("image/")) ? files : [];
}

/**
 * 这个落点有没有主人：编辑器和表单收文字，笔记纸面收整份图片。
 *
 * 浮层在 dragenter 时问过同一个问题，才敢说"松开就收进来源库"。
 */
export function isOwnedDropTarget(target: EventTarget | null, transfer: DataTransfer | null): boolean {
  if (isEditableTarget(target) || isSourceCaptureTarget(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(`[${NOTE_PAPER_IMAGE_DROP_ATTR}]`) && imageOnlyFiles(transfer).length > 0);
}

/** 当前是否有模态对话框开着：有就别弹新窗，排队等下一轮。 */
export function hasOpenModal(): boolean {
  return Boolean(document.querySelector(
    "dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']",
  ));
}

const SEEN_LINKS_KEY = "astella:source-intake-seen-links";
const MAX_SEEN_LINKS = 100;

type SeenStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): SeenStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * 问过（导入或忽略）的链接不再打扰。localStorage 持久化，
 * 重启也不对同一个链接弹第二遍；上限 100 个，只留最近的。
 */
export function readSeenLinks(storage: SeenStorage | null = defaultStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(SEEN_LINKS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

export function markLinkSeen(url: string, storage: SeenStorage | null = defaultStorage()): Set<string> {
  const seen = readSeenLinks(storage);
  seen.add(url);
  if (storage) {
    try {
      storage.setItem(SEEN_LINKS_KEY, JSON.stringify([...seen].slice(-MAX_SEEN_LINKS)));
    } catch {
      // 配额满了就只记这次会话，不挡主流程。
    }
  }
  return seen;
}
