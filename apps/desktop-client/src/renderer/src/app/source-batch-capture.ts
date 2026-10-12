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
  readonly request:
    | { readonly content: string; readonly title?: string; readonly origin?: string }
    | { readonly url: string; readonly origin?: string };
};

export type BatchCaptureOutcome = {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  /** 合并报告中实际未收录的材料数，缺省为一份。 */
  readonly count?: number;
  /** 审计 F2：同一网址已存在、没有重复建——既不是「刚收下」，也不算失败。 */
  readonly duplicate?: boolean;
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
    // 审计 F8：文件采进来的来路是文件本身，不是「粘贴的正文」——把文件名带进 origin，
    // 详情页的来源行照着念「文件 X.pdf」，列表也认得出这是文件材料。
    tasks.push({ name: file.name, request: { content: read.text, origin: `文件 ${file.name}`, ...(title ? { title } : {}) } });
  }
  return { tasks, outcomes, overflow };
}

/**
 * 一次跑完（或被中止）的批量收录都会留下这样一份回执。它活在模块层而不是某一屏的
 * state 里——审计 F1：收录跑到一半离开来源库时，进度随页面卸载被静默掐断，回来时
 * 索引只是「多了几条少了几条」，说不出断在哪、哪几份没进来。现在跑完就把回执挂在这里，
 * 来源库下次挂载/回焦时读走并展示，然后消费掉。
 */
export type BatchCaptureReceipt = {
  readonly finishedAt: number;
  /** 这一批一共要处理多少份。 */
  readonly total: number;
  /** 新收下的份数（重复的不算）。 */
  readonly accepted: number;
  /** 已存在、没有重复建的那些名字。 */
  readonly duplicates: readonly string[];
  /** 真正失败的（含读不出来、队列满、超限）。 */
  readonly failures: readonly BatchCaptureOutcome[];
  /** 因切空间/换账号而中止：后面几份没跑。 */
  readonly stopped: boolean;
};

let lastBatchReceipt: BatchCaptureReceipt | null = null;

/** 读一眼最近一次回执（不清除）。 */
export function peekBatchReceipt(): BatchCaptureReceipt | null {
  return lastBatchReceipt;
}

/** 展示过就消费掉，避免同一份回执反复出现。 */
export function consumeBatchReceipt(): void {
  lastBatchReceipt = null;
}

/**
 * 单条一句话回执（审计 F10 归档那条）：详情页做完一件跨页的事（如归档）后
 * 直接跳回来源库，回执原本留在已经卸载的详情页里。现在先寄存在这里，
 * 来源库挂载时读走并展示。
 */
let lastLibraryReceipt: string | null = null;
export function stashLibraryReceipt(text: string): void { lastLibraryReceipt = text; }
export function peekLibraryReceipt(): string | null { return lastLibraryReceipt; }
export function consumeLibraryReceipt(): void { lastLibraryReceipt = null; }

/**
 * 当前活着的收录批次。同一时刻只认最新一批：新一批开始时旧批在下一个循环收手，
 * 它的结果不再写模块回执（避免用旧数字覆盖新一批的）。
 */
let activeCaptureRun: symbol | null = null;

/** 开一批新的收录，返回它的身份牌。 */
export function beginCaptureRun(): symbol {
  const run = Symbol("capture-run");
  activeCaptureRun = run;
  return run;
}

export function isCaptureRunActive(run: symbol): boolean {
  return activeCaptureRun === run;
}

/**
 * 逐份建来源，**每建好一份就报一次进度**。
 *
 * 串行而不是并发：每一发都要在服务端占一次事务并入队一个解析任务，并发只会更快地撞上
 * 那个 50 的队列上限，而串行时 `onProgress` 报出去的数字就是读者真的能看见的进度。
 *
 * 2026-10-11（审计 F1）：这个循环**不再随某一屏卸载而收手**。`shouldStop` 只应该回答
 * 「这一批还属不属于当前空间」——切空间、换账号、或又有新的一批顶上来。离开来源库去
 * 读一条材料时，收录继续跑；跑完把回执留在模块层，回来时来源库读走它。
 *
 * 返回 `null` 表示这一批被中止（stop 了）——调用方该直接收手，不要再往屏上写回执。
 */
export async function captureSourceTasks(
  tasks: readonly CaptureTask[],
  options: {
    readonly run: symbol;
    readonly onProgress: (done: number, total: number) => void;
    /** 批次之外的中止条件：空间/账号换了就收手。默认永不中止。 */
    readonly shouldStop?: () => boolean;
  },
): Promise<BatchCaptureResult | null> {
  const outcomes: BatchCaptureOutcome[] = [];
  const duplicates: string[] = [];
  let created: BatchCaptureResult["created"] = null;
  let done = 0;
  let stopped = false;
  const halt = () => !isCaptureRunActive(options.run) || options.shouldStop?.() === true;
  for (const task of tasks) {
    if (halt()) { stopped = true; break; }
    try {
      const response = await window.astella.source.create({
        meta: createRequestMeta(),
        request: task.request,
      });
      if (halt()) { stopped = true; break; }
      const detail = unwrapGatewayResult(response);
      created = { sourceId: detail.source.id, title: detail.source.title };
      if (detail.duplicateOf) {
        // 审计 F2：重复既不是「收下 N 份」里的 N，也不是失败——单独记名，
        // 收据里写「N 份已存在」，不和解析中的材料混在一个数里。
        duplicates.push(task.name);
        outcomes.push({
          name: task.name,
          ok: true,
          duplicate: true,
          message: `已经在 ${formatRelative(detail.duplicateOf.createdAt)} 采过，没有重复建一份。`,
        });
      } else {
        outcomes.push({ name: task.name, ok: true, message: "已收下，正在解析。" });
      }
    } catch (error) {
      if (halt()) { stopped = true; break; }
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
  const failures = outcomes.filter((outcome) => !outcome.ok);
  // 中止的批次不写回执：它属于上一个空间/上一批，写进去只会把旧数字说成新事实。
  if (!stopped) {
    lastBatchReceipt = {
      finishedAt: Date.now(),
      total: tasks.length,
      accepted: outcomes.filter((outcome) => outcome.ok && !outcome.duplicate).length,
      duplicates,
      failures,
      stopped: false,
    };
  }
  if (stopped) return null;
  return { outcomes, overflow: false, created };
}
