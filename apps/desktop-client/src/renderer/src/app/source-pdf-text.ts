/**
 * PDF 文本层提取：pdf.js 给的是**带坐标的文字片段**，不是文本。
 *
 * 这一层的活是把片段重建成「行 → 段落」，因为下游（分段、制卡、搜索）读的是自然段。
 * 重建只在**几何**上做，不猜语义：不靠字号猜标题、不删「看起来像页码」的那一行——
 * 猜错的那一份会静默变成读者的材料缺失。结构只信文档自己声明的那部分（见 Word 那条路）。
 *
 * 纯函数在这里，pdf.js 的加载在 `source-pdf.ts`：用例能直接喂合成片段，不需要真的打开一份 PDF。
 */

/** pdf.js `getTextContent()` 的文本片段里这一层要用的那几项。 */
export type PdfTextItem = {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
};

type VisualLine = {
  readonly text: string;
  readonly baseline: number;
  readonly size: number;
};

/** 部首区（U+2F00–U+2FD5）的码位在正文里没有合法用途，只用于字典条目。 */
const RADICAL_FIRST = 0x2f00;
const RADICAL_LAST = 0x2fd5;

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿]/u;

/**
 * 把部首区码位折回汉字本体。
 *
 * 实测：Chromium「打印成 PDF」与部分子集化字体把 ToUnicode 写成部首码位，
 * 于是 `一` 变成 `⼀`（U+2F00）。**逐字**处理，只对这一区做 NFKC：整行归一会把 `：`（U+FF1A）
 * 顺手变成 `:`，那是把中文标点改掉，比部首残留更糟。
 */
export function normalizeRadicalCodepoints(text: string): string {
  let output = "";
  let changed = false;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= RADICAL_FIRST && code <= RADICAL_LAST) { output += char.normalize("NFKC"); changed = true; continue; }
    output += char;
  }
  return changed ? output : text;
}

const isCjk = (text: string): boolean => CJK.test(text.slice(0, 1)) || CJK.test(text.slice(-1));

/**
 * 片段 → 视觉行。
 *
 * 起新行的判据有三条，任一成立就算换行：基线跳开、pdf.js 说这一行结束了（`hasEOL`）、
 * 或者两份片段之间的水平空隙宽到像一个空格（西文词之间正是这么断的）。
 */
function toVisualLines(items: readonly PdfTextItem[]): VisualLine[] {
  const lines: { runs: string[]; baseline: number; size: number; right: number }[] = [];
  let current: (typeof lines)[number] | null = null;
  for (const item of items) {
    if (!item.str) continue;
    const baseline = item.transform[5];
    const left = item.transform[4];
    const size = item.height || Math.abs(item.transform[3]) || 0;
    if (!current || Math.abs(current.baseline - baseline) > Math.max(1.5, size * 0.35)) {
      current = { runs: [], baseline, size, right: left };
      lines.push(current);
    }
    // 行内前一段的右边界与这一段左边界之间的空档：够宽就补一个空格。
    if (current.runs.length > 0 && left - current.right > Math.max(1, current.size * 0.25)) current.runs.push(" ");
    current.runs.push(item.str);
    current.right = left + item.width;
    if (item.hasEOL) current = null;
  }
  return lines
    .map((line) => ({
      text: normalizeRadicalCodepoints(line.runs.join("")).replace(/\s+$/, ""),
      baseline: line.baseline,
      size: line.size,
    }))
    .filter((line) => line.text.trim() !== "");
}

const median = (samples: number[]): number => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];

/**
 * 段落边界的判据：比这份文档的正常行距**明显更宽**的那一次跳行。
 *
 * 行距从文档自己来（跳距的中位数），不从外部假设来。少于三处跳距时样本不够——
 * 中数就只剩那一个跳距本身，任何空行都会被它判成「正常行距」，于是退回字号的 1.8 倍。
 */
function paragraphBreaks(lines: readonly VisualLine[]): boolean[] {
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const gap = Math.abs(lines[index - 1].baseline - lines[index].baseline);
    if (gap > 0.1) gaps.push(gap);
  }
  const leading = gaps.length >= 3 ? median(gaps) * 1.55 : null;
  const breaks: boolean[] = [true];
  for (let index = 1; index < lines.length; index += 1) {
    const gap = Math.abs(lines[index - 1].baseline - lines[index].baseline);
    const fallback = Math.max(lines[index - 1].size, lines[index].size) * 1.8;
    breaks.push(leading === null ? gap > fallback : gap > leading);
  }
  return breaks;
}

/**
 * 视觉行 → 段落，并把段内的折行拼回一句。
 *
 * 怎么拼要看语言：中文在折行处补空格会在正文里留下白斑，所以任一端是汉字就直接相接；
 * 西文行尾的连字符是断词，去掉它再接；其余情况补一个空格。
 */
export function pdfItemsToMarkdown(items: readonly PdfTextItem[]): string {
  const lines = toVisualLines(items);
  if (lines.length === 0) return "";
  const breaks = paragraphBreaks(lines);
  const paragraphs: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index === 0 || breaks[index]) { paragraphs.push(line.text); continue; }
    const previous = lines[index - 1];
    const tail = paragraphs[paragraphs.length - 1];
    if (isCjk(previous.text) || isCjk(line.text)) paragraphs[paragraphs.length - 1] = tail + line.text;
    else if (previous.text.endsWith("-") && /^[a-z]/.test(line.text)) paragraphs[paragraphs.length - 1] = `${tail.replace(/-$/, "")}${line.text}`;
    else paragraphs[paragraphs.length - 1] = `${tail} ${line.text}`;
  }
  return paragraphs.join("\n\n");
}

/** 逐页提取后按页相接：页与页之间保留一个空段，不写「第 N 页」那种合成标题。 */
export function pdfPagesToMarkdown(pages: readonly (readonly PdfTextItem[])[]): string {
  return pages.map(pdfItemsToMarkdown).filter((text) => text.trim() !== "").join("\n\n");
}
