/**
 * 批量收录：**丢进来多个文件 → 一份一份建来源 → 排队解析**。
 *
 * ## 为什么有这一个模块
 *
 * 「批量丢 .md」这件事在界面上有两个入口——书房空白处的全局拖放，和来源库采集栏
 * 里的文件选择/拖放。它们做的是**同一件事**：校验 → 读正文 → 逐份建来源 → 汇报每份的结果。
 * 两处各写一份的结果是判据会漂：上限一份、900 KB 一份、「队列满了」那句话一份，
 * 而三样都是同一个服务端事实（`MAX_PENDING_JOBS_PER_WORKSPACE = 50`）。
 *
 * ## 这一条路为什么是「建来源」而不是「直接建笔记」
 *
 * 书房里每一篇笔记都挂在一个来源上；走这条路，丢进来的 .md 会变成来源库里的一条条材料，
 * 与粘贴、拖链接进来的材料**完全同构**。至于「要不要写成笔记」，那是读者在来源页自己
 * 按「开始写笔记」的决定——材料先到，笔记是后续的一步。
 */
import { createRequestMeta, getCurrentWorkspaceEpoch, gatewayErrorMessage, unwrapGatewayResult } from "./desktop-client";
import { RendererGatewayError } from "./desktop-client";
import {
  DOCUMENT_FILE_PATTERN,
  LEGACY_DOCUMENT_FILE_PATTERN,
  MAX_CAPTURE_BYTES,
  MAX_DOCUMENT_BYTES,
  PDF_FILE_PATTERN,
  TEXT_FILE_PATTERN,
  captureBytes,
  decodeCaptureText,
  formatCaptureSize,
  titleFromFileName,
} from "./source-intake";
import { createDocumentImageImporter } from "./source-document-images";
import { extractDocxMarkdown } from "./source-docx";
import { extractPdfMarkdown } from "./source-pdf";
import { formatRelative } from "../components/surfaces/notebook/surface-data";

/** 一份待收录的材料：名字给界面看，`request` 是建来源那一发的正文。 */
export type CaptureTask = {
  readonly name: string;
  readonly request: { readonly content: string; readonly title?: string } | { readonly url: string };
};

export type BatchCaptureOutcome = {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  /** 合并报告中实际未收录的材料数，缺省为一份。 */
  readonly count?: number;
};

export type BatchCaptureResult = {
  readonly outcomes: readonly BatchCaptureOutcome[];
  /** 有一份以上因为超出单批上限没有被收；界面上要如实说"多出的那几份"。 */
  readonly overflow: boolean;
  /** 最后一个成功建出来的来源，用于「打开刚收的那份」。全失败时为 null。 */
  readonly created: { readonly sourceId: string; readonly title: string } | null;
};

/**
 * 一次最多收多少份。
 *
 * 50 不是随手取的：服务端每个空间的待处理任务队列上限就是 50（`MAX_PENDING_JOBS_PER_WORKSPACE`），
 * 而建一份来源恰好入队一个解析任务。所以 50 份是「队列空着时一次能全收下」的准确上限；
 * 再往上写更大的数，收不下的那几份只会以 429 的形式回来。
 */
export const MAX_BATCH_CAPTURE_FILES = 50;

/**
 * 能不能收录：采集是 owner 专属的写动作，成员先在这里得到一句话，
 * 而不是收完 30 份再看到 30 条同样的拒绝。
 */
export async function canCaptureSource(): Promise<"allowed" | "denied" | "unknown"> {
  try {
    const response = await window.astella.capabilities.get({ meta: createRequestMeta() });
    if (!response.ok) return "unknown";
    return response.data.actionCapabilities["source.create"] === "allowed" ? "allowed" : "denied";
  } catch {
    return "unknown";
  }
}

/** 一份文件读成了正文，或者读不出来——`message` 是给读者看的那一句，不是日志。 */
export type CaptureFileRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/** 收不了的格式要说得出下一步做什么；只说「暂不解析」等于把人推回试错。 */
function unsupportedMessage(name: string): string {
  if (LEGACY_DOCUMENT_FILE_PATTERN.test(name)) {
    return `旧版文档（${name.slice(name.lastIndexOf(".")).toLowerCase()}）不解析：在 Word 里「另存为」选 .docx，或在原来的程序里导出成 PDF，再拖进来。`;
  }
  return `采集通道目前接收文本、Markdown、代码、PDF 与 Word（.docx），暂不解析 ${name}。`;
}

/** 解析出来的正文照样过正文上限：超了就把真实字节数报回去，不悄悄截断。 */
function withinTextLimit(text: string, name: string): CaptureFileRead {
  const bytes = captureBytes(text);
  if (bytes > MAX_CAPTURE_BYTES) {
    return { ok: false, message: `${name} 解析出约 ${formatCaptureSize(bytes)} 正文，超过单份正文的 ${formatCaptureSize(MAX_CAPTURE_BYTES)} 上限，请把原文拆成几份再收。` };
  }
  return { ok: true, text };
}

/**
 * 一份文件 → 正文。文本类直接读，PDF 与 Word 先在这一台机器上解析。
 *
 * 单份拖与批量拖都必须经过这里：能收的后缀、两处上限、解析失败的说法只在这一处成立，
 * 两个入口才不会对同一份文件说出不一致的话。
 */
export async function readCaptureFile(file: File): Promise<CaptureFileRead> {
  const isDocument = DOCUMENT_FILE_PATTERN.test(file.name);
  if (!isDocument && !TEXT_FILE_PATTERN.test(file.name)) {
    return { ok: false, message: unsupportedMessage(file.name) };
  }
  if (!isDocument && file.size > MAX_CAPTURE_BYTES) {
    return { ok: false, message: `这份材料约 ${formatCaptureSize(file.size)}，超过单份正文的 ${formatCaptureSize(MAX_CAPTURE_BYTES)} 上限，请分段采集。` };
  }
  if (!isDocument) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return { ok: false, message: "这份文件读不出来，换一种方式粘贴正文试试。" };
    }
    const decoded = decodeCaptureText(bytes);
    if (!decoded.ok) return decoded;
    if (!decoded.text.trim()) return { ok: false, message: "这份文件是空的，没有可收的内容。" };
    return withinTextLimit(decoded.text, file.name);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, message: `这份原文约 ${formatCaptureSize(file.size)}，超过本机一次解析的 ${formatCaptureSize(MAX_DOCUMENT_BYTES)} 上限，请先在原文程序里拆成几份。` };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, message: "这份文件读不出来，可以在原文程序里另存一份再拖。" };
  }
  const images = createDocumentImageImporter();
  const parsed = PDF_FILE_PATTERN.test(file.name) ? await extractPdfMarkdown(bytes, images.importImage) : await extractDocxMarkdown(bytes, images.importImage);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const warnings = images.warnings.length ? `\n\n（部分图片未能导入：\n${images.warnings.join("\n")}）` : "";
  const text = parsed.markdown + warnings;
  return withinTextLimit(text, file.name);
}

/**
 * 把一批文件读成待收录的任务；读不进来的就地记成一条失败，不影响同一批的其他文件。
 *
 * 顺序有意保持原样（先失败的几条排在前面）：读者扫一眼报告时，先看到的是「这几份收不了」，
 * 而不是要翻到最后才看见。
 *
 * `onReading` 报的是**解析**那一段的进度：一份几十页的 PDF 不是零耗时，没有这一句的话
 * 界面会停在「正在收进第 1/1 份…」，说的是还没发生的事。
 */
export async function readCaptureFiles(
  files: readonly File[],
  limit: number = MAX_BATCH_CAPTURE_FILES,
  onReading?: (index: number, total: number, name: string) => void,
): Promise<{ tasks: CaptureTask[]; outcomes: BatchCaptureOutcome[]; overflow: boolean }> {
  const overflow = files.length > limit;
  const tasks: CaptureTask[] = [];
  const outcomes: BatchCaptureOutcome[] = [];
  const selected = files.slice(0, limit), epoch = getCurrentWorkspaceEpoch();
  for (const [index, file] of selected.entries()) {
    if (epoch !== getCurrentWorkspaceEpoch()) break;
    onReading?.(index, selected.length, file.name);
    const read = await readCaptureFile(file);
    if (!read.ok) { outcomes.push({ name: file.name, ok: false, message: read.message }); continue; }
    const title = titleFromFileName(file.name);
    tasks.push({ name: file.name, request: { content: read.text, ...(title ? { title } : {}) } });
  }
  return { tasks, outcomes, overflow };
}

/**
 * 逐份建来源，**每建好一份就报一次进度**。
 *
 * 串行而不是并发：每一发都要在服务端占一次事务并入队一个解析任务，并发只会更快地撞上
 * 那个 50 的队列上限，而串行时 `onProgress` 报出去的数字就是读者真的能看见的进度。
 *
 * 返回 `null` 表示这批已经过期（切空间、换账号、或又来了一批）——调用方该直接收手，
 * 不要把过期批次的回执写进当前这一屏。
 */
export async function captureSourceTasks(
  tasks: readonly CaptureTask[],
  options: {
    readonly onProgress: (done: number, total: number) => void;
    readonly isCurrent: () => boolean;
  },
): Promise<BatchCaptureResult | null> {
  const outcomes: BatchCaptureOutcome[] = [];
  let created: BatchCaptureResult["created"] = null;
  let done = 0;
  for (const task of tasks) {
    if (!options.isCurrent()) return null;
    try {
      const response = await window.astella.source.create({
        meta: createRequestMeta(),
        request: task.request,
      });
      if (!options.isCurrent()) return null;
      const detail = unwrapGatewayResult(response);
      created = { sourceId: detail.source.id, title: detail.source.title };
      outcomes.push({
        name: task.name,
        ok: true,
        // 审计 F33：同一个网址不重复建——如实说「已经有一份了」，而不是假装刚收下。
        message: detail.duplicateOf
          ? `已经在 ${formatRelative(detail.duplicateOf.createdAt)} 采过，没有重复建一份。`
          : "已收下，正在解析。",
      });
    } catch (error) {
      if (!options.isCurrent()) return null;
      outcomes.push({
        name: task.name,
        ok: false,
        message: error instanceof RendererGatewayError && error.code === "rate_limited"
          ? "解析队列满了，等前面几份解析完，再把这几份拖一次。"
          : gatewayErrorMessage(error),
      });
    }
    done += 1;
    options.onProgress(done, tasks.length);
  }
  return { outcomes, overflow: false, created };
}
