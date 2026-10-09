/**
 * 带图导入一个 Markdown 包（文件夹或 zip）的渲染层一侧。
 *
 * 读盘、传图、改写正文都在主进程做完（见 `main/markdown-bundle-import.ts`），这里只负责
 * 两件事：把「先看一眼」的那份数摆出来，和把改写好的正文交回**批量收录那条老路**。
 * 建来源、进度、每份的成败、同一份不重复收——那些都不是新逻辑，是 `source-batch-capture`
 * 里本来就有的一套，两条入口共用一份判据才不会对同一批文件说两种话。
 */
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "./desktop-client";
import type { MarkdownBundleImportedV1, MarkdownBundleKind, MarkdownBundlePreviewV1 } from "@astella/shared/desktop-ipc-contracts";
import type { BatchCaptureOutcome, CaptureTask } from "./source-batch-capture";
import { formatCaptureSize } from "./source-intake";

/**
 * 读者点头之前先问一次：这个包里有几篇、几张图、几张落不了地。
 *
 * 取消选择返回 `null`（界面什么都不留）；失败也返回 `null` 前先问一句是不是取消——
 * 主进程把「不是 zip 文件」这类话放在 issues 里交回来，所以那条要走 preview。
 */
export async function inspectMarkdownBundle(kind: MarkdownBundleKind): Promise<MarkdownBundlePreviewV1 | null> {
  try {
    const result = unwrapGatewayResult(await window.astella.source.bundleImport({
      meta: createRequestMeta(),
      request: { version: 1, action: "inspect", kind },
    }));
    if (result.stage !== "preview" || result.canceled) return null;
    return result;
  } catch (error) {
    throw new Error(gatewayErrorMessage(error));
  }
}

export type BundleLocalizeResult = {
  readonly tasks: CaptureTask[];
  /** 没能落地的图片与没能收进来的那几篇：界面按批量失败那一套列出来。 */
  readonly outcomes: BatchCaptureOutcome[];
  readonly warnings: BatchCaptureOutcome[];
  readonly uploaded: number;
};

/**
 * 真的传：把包里的图片送进对象存储，交回改写好的正文。
 *
 * 一张图没传上去**不影响这篇正文被收**——正文照原样留着那串引用，界面上单独一行说这张图
 * 缺在哪。把整篇丢掉才是更糟的结果：读者会因为一张挂不上的图失去整篇笔记。
 */
export async function localizeMarkdownBundle(preview: MarkdownBundlePreviewV1): Promise<BundleLocalizeResult> {
  if (!preview.bundlePath || !preview.kind) throw new Error("请先选一个包。");
  const result = unwrapGatewayResult(await window.astella.source.bundleImport({
    meta: createRequestMeta(),
    request: { version: 1, action: "import", kind: preview.kind, bundlePath: preview.bundlePath },
  }));
  if (result.stage !== "imported") throw new Error("这个包没能导入。");
  const imported: MarkdownBundleImportedV1 = result;
  const warnings: BatchCaptureOutcome[] = imported.issues.map((item) => ({ name: item.src, ok: false, message: item.message }));
  const outcomes: BatchCaptureOutcome[] = imported.dropped.map((item) => ({ name: item.src, ok: false, message: item.message }));
  if (imported.issueOverflow > 0) {
    warnings.push({ name: `另外 ${imported.issueOverflow} 条`, ok: false, message: "这里最多列 50 条，剩下的同样是未能导入的图片。" });
  }
  return {
    tasks: imported.tasks.map((task) => ({
      name: task.name,
      request: { content: task.content, ...(task.title ? { title: task.title } : {}) },
    })),
    outcomes,
    warnings,
    uploaded: imported.uploaded,
  };
}

/** 那一句「先看一眼」的话：数字全部来自主进程，这里只负责怎么说。 */
export function describeBundlePreview(preview: MarkdownBundlePreviewV1): string {
  const parts = [`${preview.files} 篇正文`, `${preview.localizable} 张图待传（约 ${formatCaptureSize(preview.imageBytes)}）`];
  if (preview.issueOverflow > 0 || preview.issues.length > 0) {
    parts.push(`${preview.issues.length + preview.issueOverflow} 条落不了地`);
  }
  if (preview.overflow > 0) parts.push(`另有 ${preview.overflow} 篇超出单次上限，这次不收`);
  return parts.join("，");
}
