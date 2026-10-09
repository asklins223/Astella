/**
 * Word（.docx）→ Markdown。
 *
 * 结构由文档自己声明：mammoth 读的是 Word 的段落样式（Heading 1、列表、表格），
 * 所以标题层级与列表是真的，不是猜出来的。它产出语义 HTML，再由 turndown 落成 Markdown；
 * Markdown 本身没有表格，GFM 那一条规则在下面自己写。
 *
 * 内嵌图片由 mammoth 按原位置提取，上传后只把站内地址放进正文。
 */
import mammoth from "mammoth";
import TurndownService from "turndown";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { noteImageMarkdown } from "@astella/shared/note-markdown";
import type { ImportDocumentImage } from "./source-document-images";

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  hr: "---",
});

turndownService.addRule("documentImage", {
  filter: "img",
  replacement: (_content, node) => {
    const image = node as HTMLElement, src = image.getAttribute("src") ?? "";
    return sourceImageObjectKeyFromUrl(src) ? noteImageMarkdown({ src, alt: image.getAttribute("alt") ?? "" }) : "[图片未能导入]";
  },
});

function cellText(cell: HTMLElement): string {
  return turndownService.turndown(cell.innerHTML).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function rowCells(row: HTMLElement): string[] {
  const texts = Array.from(row.querySelectorAll<HTMLElement>("th, td")).map(cellText);
  // 一行一个单元格都没有（整行是空的合并格）时留一格空，否则这一行会把表格断开。
  return texts.length > 0 ? texts : [""];
}

/** GFM 表格：一行一条，单元格里的换行折成空格，竖线转义。 */
turndownService.addRule("gfmTable", {
  filter: "table",
  replacement: (_content, node) => {
    const table = node as HTMLElement;
    const rows = Array.from(table.querySelectorAll("tr")).map(rowCells);
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) => [...row, ...Array.from({ length: width - row.length }, () => "")];
    const line = (row: string[]) => `| ${pad(row).join(" | ")} |`;
    // GFM 必须有表头行；文档没标表头时第一行就是表头，这与读者在 Word 里看到的一致。
    const [header, ...body] = rows;
    const caption = table.querySelector("caption");
    const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
    return `\n\n${caption ? `${cellText(caption)}\n\n` : ""}${line(header)}\n${separator}\n${body.map(line).join("\n")}\n\n`;
  },
});

export type DocxMarkdown = { readonly markdown: string; readonly images: number };

/**
 * mammoth 的语义 HTML → Markdown。
 *
 * 单独露出来有两个理由：这一层的规则（表格、图片）是自己写的，要能单独测；
 * 而 mammoth 的 Node 入口根本不接 `arrayBuffer`，用例里既造不出浏览器那一份解析，
 * 也不该为了测试去改运行时走的那条路。
 */
export function htmlToMarkdown(html: string): DocxMarkdown {
  return {
    markdown: turndownService.turndown(html).trim(),
    images: (html.match(/<img\b/g) ?? []).length,
  };
}

export type DocxExtraction =
  | ({ readonly ok: true } & DocxMarkdown)
  | { readonly ok: false; readonly message: string };

export async function extractDocxMarkdown(bytes: Uint8Array, importImage: ImportDocumentImage): Promise<DocxExtraction> {
  try {
    let ordinal = 0;
    const result = await mammoth.convertToHtml(
      // mammoth 的浏览器入口只认 ArrayBuffer；这里的视图本来就是整份文件，不需要复制。
      { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer },
      { convertImage: mammoth.images.imgElement(async image => {
        const label = `Word 图片 ${++ordinal}`;
        try { return { src: await importImage(new Uint8Array(await image.readAsArrayBuffer()), image.contentType, label) ?? "" }; }
        catch { return { src: "" }; }
      }) },
    );
    const converted = htmlToMarkdown(result.value);
    if (converted.markdown === "") {
      return { ok: false, message: "这份 Word 里没有可收录的文字或图片。" };
    }
    return { ok: true, ...converted };
  } catch (failure) {
    return {
      ok: false,
      message: `这份 Word 解析失败：${failure instanceof Error ? failure.message.slice(0, 160) : "文件可能已损坏，在原来的程序里另存一份再试"}。`,
    };
  }
}
