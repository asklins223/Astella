/**
 * PDF 提取的两段接法：pdf.js 的加载（懒加载 + 自己的 Worker）在这里，
 * 「片段 → 正文」的几何重建在 `source-pdf-text.ts`。
 *
 * 拆开的理由是**代价**：pdf.js 与它的 worker 只在真的拖进来一份 PDF 时才进界面，
 * 不该占首屏那一份包。
 */
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { extractPdfPageImages, pdfPageMarkdown } from "./source-pdf-images";
import type { ImportDocumentImage } from "./source-document-images";

let pdfLibrary: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfLibrary(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfLibrary) {
    pdfLibrary = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })().catch((failure: unknown) => { pdfLibrary = null; throw failure; });
  }
  return pdfLibrary;
}

/** pdf.js 的失败种类：这一层把它们翻译成读者能照着做的那一句话。 */
function extractionFailure(failure: unknown): string {
  const name = (failure as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") return "这份 PDF 设了打开密码，先去掉密码再拖进来。";
  if (name === "InvalidPDFException") return "这份 PDF 读不出结构，可能已经损坏；换一份或在原程序里另存一次再试。";
  return `这份 PDF 解析失败${failure instanceof Error && failure.message ? `：${failure.message.slice(0, 160)}` : "，可以重新拖一次试试。"}`;
}

export type PdfExtraction =
  | { readonly ok: true; readonly markdown: string; readonly pages: number }
  | { readonly ok: false; readonly message: string };

/**
 * 取每一页的文字层片段。
 *
 * `getTextContent()` 默认跳过 marked content（那是要画文本层用的），回来的就是带坐标的
 * 文字片段；`TextMarkedContent` 那一种没有 `str`，在这里滤掉。
 */
export async function extractPdfMarkdown(bytes: Uint8Array, importImage: ImportDocumentImage): Promise<PdfExtraction> {
  let loading: ReturnType<typeof import("pdfjs-dist")["getDocument"]> | null = null;
  try {
    const pdfjs = await loadPdfLibrary();
    loading = pdfjs.getDocument({ data: bytes });
    const pdf = await loading.promise;
    const pages: string[] = [];
    for (let ordinal = 1; ordinal <= pdf.numPages; ordinal += 1) {
      const page = await pdf.getPage(ordinal);
      try {
        const content = await page.getTextContent();
        const images = await extractPdfPageImages(page, pdfjs.OPS, importImage);
        pages.push(pdfPageMarkdown(content.items.filter((item): item is TextItem => "str" in item), images));
      } finally { page.cleanup(); }
    }
    const markdown = pages.filter(text => text.trim()).join("\n\n");
    if (!markdown.trim()) return { ok: false, message: `这份 ${pdf.numPages} 页的 PDF 没有可提取的文字或图片；如需扫描件文字，请先做文字识别。` };
    return { ok: true, markdown, pages: pdf.numPages };
  } catch (failure) { return { ok: false, message: extractionFailure(failure) }; }
  finally { await loading?.destroy().catch(() => undefined); }
}
