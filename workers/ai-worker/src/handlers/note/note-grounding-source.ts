import { isGroundingMarkerV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-measure";

/**
 * 「这句引文真的在这块里吗」——三条生成链共用的底本，**只有一份**。
 *
 * 这段逻辑过去同时住在 `note-mind-map-source.ts` / `note-overview-generate.ts` /
 * `note-expansion-generate.ts` 三份近似拷贝里（各自的 `compactEvidence` + `exactQuote`），
 * 而三处的注释都写着"口径只在 shared 那一处声明"——真正被声明的只有引号字形与标记字符
 * （`isGroundingMarkerV1`），**压缩与定位这段是各写各的**，于是同一种错误要修三次：
 * 实测（2026-10-14，37 万字符长文）表格竖线与行首编号在脑图上连发两版判死，
 * 速看同一句在悄悄 `pointsDropped`，拓展那条链则整份任务判红。
 *
 * 各链原有的差别显式留在这里，不再靠"抄的时候恰好不一样"来表达：
 * · `minNeedleChars` —— 速看/拓展要求至少 8 个字才当一条引用；脑图不设（4 个字的
 *   「固定电压」也是真引用，砍掉它会把现有用例判红）。
 * · `caseInsensitive` —— 拓展按小写比对（它的素材里英文缩写大小写不稳定）。
 */
export type QuoteGroundingOptions = {
  /** 引文短于这个字数就直接不算引用；未设＝不设下限。 */
  minNeedleChars?: number;
  /** 比对时忽略大小写（默认不忽略）。 */
  caseInsensitive?: boolean;
};

/**
 * 行首的排版外壳：列表符号、有序编号、标题井号、引用尖角。
 *
 * 页面上这些字符画成圆点/编号/标题层级，**不进正文文本**（`noteBlockRenderedTextV1`
 * 解析 markdown 后就没有它们），而模型从素材里抄引文时会连 `1. `、`- ` 一起抄下来——
 * 实测（2026-10-14，节点 g1n3 引第 14 段）连发两版判死，差的就是开头那个 `1. `。
 * 这与 `plainTextForGroundingV1` 里那几条 `.replace` 是同一条规则；这里按**字符下标**
 * 跳过，好让 `exactQuote` 仍能把命中段落按原下标切回原文（整串替换会丢掉下标）。
 * 缩进 4 空格起的行是代码块、不是列表，故不匹配。
 */
const LINE_ORNAMENT_V1 = /^[ \t]{0,3}(?:[-*+][ \t]+|#{1,6}[ \t]+|\d+[.)][ \t]+|[>][ \t]?)/gmu;

function lineOrnamentPositions(value: string): Set<number> {
  const skipped = new Set<number>();
  for (const match of value.matchAll(LINE_ORNAMENT_V1)) {
    const start = match.index ?? 0;
    for (let at = 0; at < match[0].length; at += 1) skipped.add(start + at);
  }
  return skipped;
}

export function compactEvidence(value: string, options: QuoteGroundingOptions = {}): { text: string; sourceOffsets: number[] } {
  const chars = Array.from(value);
  const ornaments = lineOrnamentPositions(value);
  const text: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    // Markdown 标记与引号字形都不算内容差别（口径只在 shared 那一处声明）。
    if (/\s/u.test(char) || isGroundingMarkerV1(char)) continue;
    // 行首外壳整段不参与比较：两边都去掉，命中段落仍按原文下标切回。
    if (ornaments.has(index)) continue;
    text.push(options.caseInsensitive ? char.toLocaleLowerCase() : char);
    sourceOffsets.push(index);
  }
  return { text: text.join(""), sourceOffsets };
}

export function exactQuote(blockText: string, candidate: string, options: QuoteGroundingOptions = {}): string | null {
  const needle = compactEvidence(candidate, options).text;
  if (needle.length < 1) return null;
  const source = compactEvidence(blockText, options);
  // 下限是"别拿两个词糊弄"，不是固定 8 个字：短段（不足 40 字）里 4 个字已经能认出
  // 说的是哪件事（三行清单里的「明天继续。」就是全部依据），长段仍按 8 个字卡。
  const sourceChars = Array.from(source.text).length;
  const floor = sourceChars < 40 ? 4 : (options.minNeedleChars ?? 0);
  const minimum = options.minNeedleChars === undefined ? undefined
    : Math.min(floor, Math.max(1, sourceChars));
  if (minimum !== undefined && Array.from(needle).length < minimum) return null;
  const offset = source.text.indexOf(needle);
  if (offset < 0) return null;
  // `indexOf` 给的是 UTF-16 码元下标，而 sourceOffsets 是按**码点**记的：正文里只要有
  // emoji 这类增补平面字符，两者就不再相等——直接用会把一条本来正确的引用判成
  // "核不回原文"。这一处换算此前只在脑图/速看两份拷贝里，漏掉的那份就会误判。
  const start = Array.from(source.text.slice(0, offset)).length;
  const from = source.sourceOffsets[start];
  const to = source.sourceOffsets[start + Array.from(needle).length - 1];
  if (from === undefined || to === undefined) return null;
  const quote = Array.from(blockText).slice(from, to + 1).join("").trim();
  // 引多长由它要支撑的那个知识点决定：定一个"太短不算引用"的闸是为了别让模型用
  // 两个字糊弄过去，不是给引文套字数上限。
  return quote.length > 0 ? quote : null;
}
