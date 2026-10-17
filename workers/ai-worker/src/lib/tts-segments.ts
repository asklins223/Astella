/**
 * P3 TTS 切句（§11.3）：Worker 是切句唯一所有者。
 *
 * - 输入为已净化可见文本（Markdown 标记/URL/代码块/隐藏 metadata 已在
 *   validateCompanionOutput 后由本模块剔除，不进入 voice segment）；
 * - 切句优先 `。！？；\n` 或 `.?!;` + 空白；句子至少 8 个中文字符，
 *   final 强制 flush；单段最多 160 字符，超限在最近合法标点/空白强制切分；
 * - 每 run 的段数与总字数**不另立上限**：由回复合同 `COMPANION_REPLY_MAX_CHARS`
 *   派生（回复多长就朗读多长）。以前这里抄过一份 200 段／20000 字，对着的是早已
 *   放宽的旧硬上限，结果是长回复的后半段安静地没有声音；
 *   2026-08-12+（15a 新反馈）：用户明确不要朗读上限，去掉原 20 段/2000 字、
 *   40 段/4000 字的限制。
 * - 净化后为空 → 零段（不发 voice.segment.ready）；
 * - 每段至少含一个读得出来的字：`。”` 后紧跟空行时右引号并进下一段，不单独成段；
 * - segmentId = sha256(runId:ordinal:text)（64 hex，稳定唯一）；textSha256 = sha256(text)。
 */

import { createHash } from "node:crypto";
import { COMPANION_REPLY_MAX_CHARS } from "@astella/shared";

export const TTS_MAX_SEGMENT_CHARS = 160;
/** 朗读的范围就是回复的范围：这两数由回复合同派生，不在这里第二次决定能念多少。 */
export const TTS_MAX_TOTAL_CHARS = COMPANION_REPLY_MAX_CHARS;
export const TTS_MAX_SEGMENTS = Math.ceil(COMPANION_REPLY_MAX_CHARS / TTS_MAX_SEGMENT_CHARS) + 1;
/** 15b 二期（问题2 修复）：首段提前触发的最小字符数——流式文字生成中，
 *  缓冲达到该长度即切出首段（不要求完整句），让 TTS 合成尽早开始，声音
 *  与文字感官同步（"字幕般"）；后续段仍按完整句切，朗读连贯性不受影响。 */
export const TTS_FIRST_SEGMENT_MIN_CHARS = 14;
/**
 * 展示段的目标长度（方案 29 §14.11 修复 ④）。
 *
 * 一段一次合成，**合成时间与字数近似成正比**，而它必须在下一段的播放时间里跑完
 * （引擎对同一用户是串行的）。实测段长 p50 = 19、p90 = 41、最长 97 字；那几条
 * 90+ 字的段一次要合成 3 秒以上，一旦前一段的音频比它短，中间就是一段可听静音。
 *
 * 所以：一句之内如果没有句末标点、但已经攒过目标长度且有逗号级停顿，就先切出去
 * （逗号本来就是朗读的自然停顿，切在这里不伤语气）。目标 48 字只影响 p90 之后
 * 那条长尾——p50/p90 的段一个都不会被切开。
 */
export const TTS_DISPLAY_SEGMENT_TARGET_CHARS = 48;

export interface CompanionTtsSegment {
  ordinal: number;
  segmentId: string;
  text: string;
  textSha256: string;
}

const SPLIT_PATTERN = /(?<=[。！？；\n.!?;])\s*/;
const HARD_SPLIT_PATTERN = /(?<=[，,、])/;
const SENTENCE_END_CHAR = /[。！？；\n.!?;]/;
/** 读得出来的字：字母/数字（含中日韩）。引号、括号、破折号、空白都不算。 */
const SPEAKABLE_CHAR = /[\p{L}\p{N}]/u;
/**
 * 朗读段里必须至少有一个读得出来的字。
 *
 * `。”\n\n下一个例子：…` 这种排版里，`\n` 自己就是切分字符，于是右引号被顶成
 * 孤零零一段。那种段引擎直接拒（实测 qwen 报 `Please ensure input text is valid`），
 * 拒了还要回落 edge、客户端重试三次——一段就是六到十一秒的可听静音。
 */
function hasSpeakableChar(text: string): boolean {
  return SPEAKABLE_CHAR.test(text);
}

/** 目标长度内最后一个"逗号级停顿"之后的位置；没有就返回 -1。 */
function lastSecondaryBoundary(text: string, limit: number): number {
  for (let index = Math.min(text.length, limit) - 1; index >= 0; index -= 1) {
    if (/[，,、]/.test(text[index] ?? "")) return index + 1;
  }
  return -1;
}
const MARKDOWN_BLOCK_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const URL_PATTERN = /https?:\/\/[^\s，。！？；,.!?;]+/g;
// 只剥离“行首标记/成对强调/链接语法”，不误删正文中的半角括号、连字符、
// 方括号等普通字符（如 “第3-4题 (b)”、“[重要]” 需原样朗读）。
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
// 有序列表标记也要剥：可见正文从 §4.8 起保留 markdown，实机落库的朗读段里出现过
// 单独一段 `4.`——TTS 会把它念成"四点"。`1.5 米` 这种不会被误伤（数字后必须紧跟
// `.`/`)` 再加空白才算列表项）。
const MARKDOWN_LINE_MARKERS = /^[#>*]{1,6}\s+|^\s*[-+]\s+|^\s*\d+[.)]\s+|^\s*\|/gm;
const MARKDOWN_EMPHASIS_PATTERN = /\*\*|__|~~/g;

/** 净化可见文本：去掉代码块/行内代码、URL、markdown 语法后压缩空白。 */
export function purifyVoiceText(text: string): string {
  let out = text
    .replace(/\[\^web-[a-zA-Z0-9_-]+\]/g, "")
    .replace(MARKDOWN_BLOCK_PATTERN, " ")
    .replace(URL_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, "$1");
  // Tables and math are display-native; reading their source syntax aloud is
  // never intelligible. Project them before markdown whitespace is collapsed.
  out = replaceTablesForSpeech(out);
  out = replaceMathForSpeech(out);
  out = replaceBareFormulasForSpeech(out);
  return out
    .replace(MARKDOWN_LINE_MARKERS, " ")
    .replace(MARKDOWN_EMPHASIS_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GREEK_SPEECH: Record<string, string> = {
  alpha: "阿尔法", beta: "贝塔", gamma: "伽马", delta: "德尔塔", Delta: "德尔塔",
  epsilon: "艾普西龙", varepsilon: "艾普西龙", zeta: "泽塔", eta: "伊塔", theta: "西塔",
  Theta: "西塔", iota: "约塔", kappa: "卡帕", lambda: "兰姆达", Lambda: "兰姆达",
  mu: "缪", nu: "纽", xi: "克西", Xi: "克西", pi: "派", Pi: "派", rho: "柔",
  sigma: "西格玛", Sigma: "西格玛", tau: "陶", upsilon: "宇普西龙", phi: "斐",
  varphi: "斐", Phi: "斐", chi: "卡", psi: "普西", Psi: "普西", omega: "欧米伽",
  Omega: "欧米伽", partial: "偏", nabla: "梯度", infty: "无穷",
};
const UNIT_SPEECH: Array<[RegExp, string]> = [
  [/m\/s\^?2/g, "米每二次方秒"], [/m\/s/g, "米每秒"], [/N\/m/g, "牛每米"],
  [/kg\b/g, "千克"], [/km\/h/g, "千米每小时"],
  [/(?<=\d)\s*s\b/g, " 秒"],
  [/(?<=\d)\s*N\b/g, "牛"], [/(?<=\d)\s*J\b/g, "焦"],
  [/(?<=\d)\s*W\b/g, "瓦"], [/(?<=\d)\s*V\b/g, "伏"], [/(?<=\d)\s*A\b/g, "安"],
  [/(?<=\d)\s*Pa\b/g, "帕"], [/(?<=\d)\s*Hz\b/g, "赫兹"], [/(?<=\d)\s*mol\b/g, "摩尔"],
];
const OPERATOR_SPEECH: Array<[RegExp, string]> = [
  [/\\times|\\cdot/g, " 乘 "], [/\\div/g, " 除以 "], [/\\pm/g, " 正负 "],
  [/\\leq?|≤/g, " 小于等于 "], [/\\geq?|≥/g, " 大于等于 "], [/\\neq?|≠/g, " 不等于 "],
  [/\\approx/g, " 约等于 "], [/\\rightarrow|\\to/g, " 趋于 "], [/\\infty/g, " 无穷 "],
  [/\\sum/g, " 求和 "], [/\\int/g, " 积分 "], [/\\partial/g, " 偏 "],
];

/**
 * 裸公式（没有 `$…$`/LaTeX 定界）的朗读投影。
 *
 * 讲解里最常见的写法就是 `P = U²/R`、`P ∝ 1/R` 这种纯文本式子；只处理带 `=` 或
 * `∝` 的连续片段，正文里的斜杠（"和/或"、日期）不碰。
 */
const SUPerscript_SPEECH: Array<[RegExp, string]> = [
  [/²/g, " 的平方"], [/³/g, " 的立方"], [/⁻¹/g, " 的负一次方"],
];
const BARE_FORMULA_SPAN = /[A-Za-z0-9α-ωΑ-Ω²³⁻¹∝=+\-*/×·≤≥≈^_().%\s]{3,40}/gu;

function speakBareFormulaSpan(span: string): string {
  if (!/[=∝]/.test(span) || !/[A-Za-z]/u.test(span)) return span;
  let out = span;
  for (const [pattern, replacement] of SUPerscript_SPEECH) out = out.replace(pattern, replacement);
  // `I²R` multiplies by juxtaposition.
  out = out.replace(/(平方|立方|负一次方)\s*([A-Za-z])/g, "$1 乘 $2");
  // Run the operator pass here too: this helper both projects bare spans and
  // finishes spans already spoken by the `$…$` path (`U 的平方/R`).
  out = out.replace(/\b1\s*\/\s*([A-Za-z][A-Za-z0-9]*)/g, "$1 分之一");
  out = out.replace(/\s*∝\s*/g, " 正比于 ");
  out = out.replace(/\s*[×·]\s*/g, " 乘 ");
  out = out.replace(/\s*\/\s*/g, " 除以 ");
  out = out.replace(/\s*=\s*/g, " 等于 ");
  out = out.replace(/\s*\+\s*/g, " 加 ");
  out = out.replace(/\s*-\s*/g, " 减 ");
  return out;
}

function replaceBareFormulasForSpeech(text: string): string {
  // The `$…$` path already spoke `U^2` into "U 的平方"; finish the division it left.
  const spoken = text.replace(/(的平方|的立方|的负一次方)\s*\/\s*([A-Za-z0-9])/g, "$1 除以 $2");
  const formulas = spoken.replace(BARE_FORMULA_SPAN, (span) => (span.includes("=") || span.includes("∝")
    ? speakBareFormulaSpan(span)
    : span));
  // Standalone powers outside a formula (`U² 也是常数`, `3 m²`) read as words too.
  return formulas.replace(/([A-Za-z0-9])\s*([²³])/g, (_all, base: string, mark: string) => (
    mark === "²" ? `${base} 平方` : `${base} 立方`
  ));
}

function readBraceGroup(text: string, start: number): { content: string; end: number } | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { content: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function skipSpaces(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
  return index;
}

function replaceBraceCommands(text: string, pattern: RegExp, render: (args: string[]) => string): string {
  let out = text;
  for (let guard = 0; guard < 32; guard += 1) {
    const match = pattern.exec(out);
    if (!match || match.index === undefined) break;
    let cursor = match.index + match[0].length;
    const groups: string[] = [];
    let failed = false;
    for (let group = 0; group < 2; group += 1) {
      cursor = skipSpaces(out, cursor);
      const parsed = readBraceGroup(out, cursor);
      if (!parsed) { failed = true; break; }
      groups.push(parsed.content);
      cursor = parsed.end;
    }
    if (failed) {
      out = out.slice(0, match.index) + "分数" + out.slice(cursor);
      continue;
    }
    out = out.slice(0, match.index) + render(groups) + out.slice(cursor);
  }
  return out;
}

function replaceSqrtCommands(text: string): string {
  let out = text;
  for (let guard = 0; guard < 16; guard += 1) {
    const match = /\\sqrt\b/.exec(out);
    if (!match || match.index === undefined) break;
    let cursor = match.index + match[0].length;
    let degree = "";
    if (out[cursor] === "[") {
      const close = out.indexOf("]", cursor + 1);
      if (close < 0) break;
      degree = out.slice(cursor + 1, close).trim();
      cursor = close + 1;
    }
    const parsed = readBraceGroup(out, skipSpaces(out, cursor));
    if (!parsed) {
      out = out.slice(0, match.index) + "根号" + out.slice(cursor);
      continue;
    }
    const body = spokenFormula(parsed.content);
    out = out.slice(0, match.index) + (degree ? `${spokenFormula(degree)} 次根号 ${body}` : `根号 ${body}`) + out.slice(parsed.end);
  }
  return out;
}

function replaceScripts(text: string): string {
  return text
    .replace(/([A-Za-z0-9)\]}])_\{([^{}]*)\}/g, (_all, base: string, sub: string) => `${base} 下标 ${spokenFormula(sub)}`)
    .replace(/([A-Za-z0-9)\]}])_([A-Za-z0-9]+)/g, (_all, base: string, sub: string) => `${base} 下标 ${sub}`)
    .replace(/([A-Za-z0-9)\]}])\^\{([^{}]*)\}/g, (_all, base: string, exp: string) => `${base} 的${spokenExponent(exp)}`)
    .replace(/([A-Za-z0-9)\]}])\^([A-Za-z0-9+-]+)/g, (_all, base: string, exp: string) => `${base} 的${spokenExponent(exp)}`);
}

function spokenExponent(raw: string): string {
  const exp = spokenFormula(raw).trim();
  if (exp === "2") return "平方";
  if (exp === "3") return "立方";
  if (exp === "-1") return "负一次方";
  return `${exp} 次方`;
}

/** Convert a single formula (already stripped of delimiters) to spoken Chinese. */
export function spokenFormula(raw: string): string {
  let out = raw.trim();
  if (/\\(?:begin|end)\b/.test(out) || /&/.test(out) || /\\\\/.test(out)) return "这个公式";
  // Unwrap size/style wrappers first; their braces are not semantic.
  out = out.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$1");
  out = out.replace(/\\ /g, " ")
    .replace(/\\(?:left|right)\b/g, " ")
    .replace(/\\[,;!]/g, " ")
    .replace(/\\(?:quad|qquad)\b/g, " ");
  out = out.replace(/\\(?:vec|hat|bar|tilde)\s*\{([^{}]*)\}/g, "$1");
  out = replaceBraceCommands(out, /\\(?:d|t)?frac\b/g, ([numerator, denominator]) =>
    `${spokenFormula(denominator)} 分之 ${spokenFormula(numerator)} `);
  out = replaceSqrtCommands(out);
  for (const [pattern, replacement] of UNIT_SPEECH) out = out.replace(pattern, replacement);
  out = replaceScripts(out);
  out = out.replace(/(\d+(?:\.\d+)?)\s*\\?%/g, (_all, value: string) => `百分之${value}`);
  for (const [pattern, replacement] of OPERATOR_SPEECH) out = out.replace(pattern, replacement);
  out = out.replace(/\\([A-Za-z]+)/g, (_all, name: string) => GREEK_SPEECH[name] ?? " ");
  out = out.replace(/[{}]/g, " ")
    .replace(/&/g, " ")
    .replace(/\\\\/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Matrices/environments and partial formulas have no reliable spoken form.
  if (/\\|\b(?:begin|end|pmatrix|bmatrix|matrix|cases)\b/.test(out)) return "这个公式";
  if (!out) return "这个公式";
  return out
    .replace(/([=+])/g, " $1 ")
    .replace(/(?<=\S)-(?=\S)/g, " 减 ")
    .replace(/= ?/g, "等于 ")
    .replace(/\+ ?/g, "加 ")
    .replace(/\s+/g, " ")
    .trim();
}

function spotMathDelimiters(text: string): string {
  const convert = (formula: string): string => spokenFormula(formula);
  return text
    .replace(/\$\$([\s\S]*?)\$\$/g, (_all, formula: string) => convert(formula))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_all, formula: string) => convert(formula))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_all, formula: string) => convert(formula))
    .replace(/\$([^$\n]+)\$/g, (_all, formula: string) => convert(formula));
}

function replaceMathForSpeech(text: string): string {
  let out = spotMathDelimiters(text);
  // A bare environment (matrix/cases) has no reliable spoken form.
  out = out.replace(/\\begin\{[^{}]+\}[\s\S]*?\\end\{[^{}]+\}/g, "这个公式");
  out = out.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$1");
  out = out.replace(/\\ /g, " ").replace(/\\(?:left|right)\b/g, " ")
    .replace(/\\[,;!]/g, " ").replace(/\\(?:quad|qquad)\b/g, " ");
  // Also handle bare commands after a segmenter cut through a formula.
  out = replaceBraceCommands(out, /\\(?:d|t)?frac\b/g, ([numerator, denominator]) =>
    `${spokenFormula(denominator)} 分之 ${spokenFormula(numerator)} `);
  out = replaceSqrtCommands(out);
  for (const [pattern, replacement] of UNIT_SPEECH) out = out.replace(pattern, replacement);
  out = replaceScripts(out);
  out = out.replace(/(\d+(?:\.\d+)?)\s*\\?%/g, (_all, value: string) => `百分之${value}`);
  for (const [pattern, replacement] of OPERATOR_SPEECH) out = out.replace(pattern, replacement);
  out = out.replace(/\\([A-Za-z]+)/g, (_all, name: string) => GREEK_SPEECH[name] ?? " ");
  // Never send a raw backslash/brace tail to TTS.
  return out.replace(/\\[A-Za-z]*/g, " ").replace(/[{}]/g, " ");
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, "|").trim());
}

function isTableSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function spokenTableCell(cell: string): string {
  const spoken = spokenFormula(cell);
  return spoken === "这个公式" && /[\\$^_{}]/.test(cell) ? "这个公式" : spoken;
}

function renderTableForSpeech(rows: readonly string[]): string {
  const parsed = rows.map(tableCells);
  const separatorIndex = parsed.findIndex(isTableSeparator);
  const header = separatorIndex > 0 ? parsed[0]! : null;
  const data = parsed.filter((_cells, index) => index !== separatorIndex && (header === null || index !== 0));
  if (data.length === 0) {
    return header ? `表格，列有：${header.map(spokenTableCell).join("、")}。` : "";
  }
  const lines: string[] = [];
  if (header) {
    lines.push(`表格，列有：${header.map(spokenTableCell).join("、")}。`);
  }
  const limit = Math.min(data.length, 4);
  for (let index = 0; index < limit; index += 1) {
    const cells = data[index]!;
    if (header) {
      const pairs = cells.map((cell, column) => {
        const key = header[column] ?? `第${column + 1}列`;
        return `${spokenTableCell(key)} 是 ${spokenTableCell(cell) || "空"}`;
      });
      lines.push(`第 ${index + 1} 行，${pairs.join("，")}。`);
    } else {
      lines.push(`第 ${index + 1} 行：${cells.map(spokenTableCell).join("，")}。`);
    }
  }
  if (data.length > limit) lines.push(`其余 ${data.length - limit} 行见屏幕。`);
  return lines.join("");
}

function replaceTablesForSpeech(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      out.push(line);
      continue;
    }
    const rows: string[] = [];
    while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? "")) {
      rows.push(lines[index]!);
      index += 1;
    }
    index -= 1;
    out.push(renderTableForSpeech(rows));
  }
  return out.join("\n");
}

/**
 * §11.3 增量切段（2026-08-12+ 15b：字幕般流式 TTS）。
 *
 * 与 splitCompanionTtsSegments 的区别：输入是"新增的流式文本"而非全文——
 * 每次调用只切出**以句结束符结尾的完整句**，未完成句留在 rest 下次继续；
 * isFinal=true 时把 rest 一并切出（final flush）。
 *
 * 段上限（maxSegments/maxTotalChars）按已发段累计维护：超限的剩余文本
 * 直接丢弃（只显示文字、不朗读），与全文版语义一致。
 *
 * 注意：净化（purifyVoiceText）按"rest+新增"整体执行，跨 delta 的 markdown
 * 边界处理可能不完美（偶发残留符号，可接受——TTS 文本）。
 */
export interface IncrementalTtsState {
  /** 未完成句（净化后），等待与后续文本拼成完整句 */
  rest: string;
  /** 已发出段数（ordinal 从 sentCount+1 起） */
  sentCount: number;
  /** 已发出段总字符数 */
  sentChars: number;
}

export interface IncrementalTtsSplit {
  segments: CompanionTtsSegment[];
  next: IncrementalTtsState;
}

/**
 * 已提交可见正文上的稳定区间切分。与旧增量切句器不同，它不净化、压缩或重排文字，
 * 因而 `displayText === fullText.slice(displayStart, displayEnd)` 始终成立，客户端可以
 * 直接用绝对下标同步字幕，不再做易错的字符串前缀匹配。
 */
export interface CompanionDisplaySegmentState {
  readonly cursor: number;
  readonly sentCount: number;
}

export interface CompanionDisplaySegment {
  readonly ordinal: number;
  readonly displayText: string;
  readonly displayStart: number;
  readonly displayEnd: number;
}

export function splitCommittedDisplaySegments(
  fullText: string,
  state: CompanionDisplaySegmentState,
  isFinal = false,
  opts?: {
    readonly firstSegmentMinChars?: number;
    readonly maxSegmentChars?: number;
    readonly maxSegments?: number;
    /** 目标段长；超过它且句内没有句末标点时，在逗号级停顿处先切一段（§14.11 ④）。 */
    readonly targetSegmentChars?: number;
    /** Model-authored changes in delivery; no sentence should inherit a later sentence's expression. */
    readonly expressionBoundaries?: readonly number[];
  },
): { readonly segments: CompanionDisplaySegment[]; readonly next: CompanionDisplaySegmentState } {
  const maxSegmentChars = opts?.maxSegmentChars ?? TTS_MAX_SEGMENT_CHARS;
  const maxSegments = opts?.maxSegments ?? TTS_MAX_SEGMENTS;
  const firstSegmentMinChars = opts?.firstSegmentMinChars ?? TTS_FIRST_SEGMENT_MIN_CHARS;
  const targetSegmentChars = Math.min(
    maxSegmentChars,
    opts?.targetSegmentChars ?? TTS_DISPLAY_SEGMENT_TARGET_CHARS,
  );
  let cursor = Math.min(Math.max(0, state.cursor), fullText.length);
  let ordinal = state.sentCount;
  const segments: CompanionDisplaySegment[] = [];

  const push = (start: number, end: number): void => {
    let displayStart = start;
    let displayEnd = end;
    while (displayStart < displayEnd && /\s/.test(fullText[displayStart] ?? "")) displayStart += 1;
    while (displayEnd > displayStart && /\s/.test(fullText[displayEnd - 1] ?? "")) displayEnd -= 1;
    cursor = end;
    if (displayEnd <= displayStart || ordinal >= maxSegments) return;
    if (!hasSpeakableChar(fullText.slice(displayStart, displayEnd))) return;
    ordinal += 1;
    segments.push({
      ordinal,
      displayText: fullText.slice(displayStart, displayEnd),
      displayStart,
      displayEnd,
    });
  };

  while (cursor < fullText.length && ordinal < maxSegments) {
    const remaining = fullText.slice(cursor);
    const hardEnd = Math.min(fullText.length, cursor + maxSegmentChars);
    let boundary = -1;
    const scanLimit = Math.min(remaining.length, maxSegmentChars);
    let pendingHasSpeakableChar = false;
    for (let index = 0; index < scanLimit; index += 1) {
      const char = remaining[index] ?? "";
      if (!pendingHasSpeakableChar && SPEAKABLE_CHAR.test(char)) pendingHasSpeakableChar = true;
      if (!SENTENCE_END_CHAR.test(char)) continue;
      // 切下去这一段没有可读的字：不在这里切，继续往后找停顿，让这点标点并进下一段
      // （它本来就属于上一句的收尾，读起来也只是静音）。
      if (!pendingHasSpeakableChar) continue;
      boundary = cursor + index + 1;
      break;
    }
    const expressionEnd = opts?.expressionBoundaries?.find(
      (end) => end > cursor && end <= hardEnd && hasSpeakableChar(fullText.slice(cursor, end)),
    );
    if (expressionEnd !== undefined && (boundary < 0 || expressionEnd < boundary)) boundary = expressionEnd;

    if (boundary > cursor) {
      // 句末标点**离得太远**（超过目标段长）而句内有逗号级停顿：先切在逗号上
      // （§14.11 ④）。一段一次合成、同一用户的合成是串行的，段越长越可能跑不进
      // 前一段的播放时间——那中间就是一段可听静音。切在逗号上是朗读的自然停顿。
      if (boundary - cursor > targetSegmentChars) {
        const secondary = lastSecondaryBoundary(remaining, targetSegmentChars);
        if (secondary > 0) {
          push(cursor, cursor + secondary);
          continue;
        }
      }
      push(cursor, boundary);
      continue;
    }
    // 整段扫不到句末标点（超长句）：同样先在逗号处切，再退到 160 硬上限。
    if (remaining.length > targetSegmentChars) {
      const secondary = lastSecondaryBoundary(remaining, targetSegmentChars);
      if (secondary > 0) {
        push(cursor, cursor + secondary);
        continue;
      }
    }
    if (remaining.length >= maxSegmentChars) {
      push(cursor, hardEnd);
      continue;
    }
    if (!isFinal && ordinal === 0 && remaining.trim().length >= firstSegmentMinChars) {
      // 首段尽早发出，但保持这次已经提交的稳定前缀完整，避免把一个短句切成多个请求。
      push(cursor, fullText.length);
      continue;
    }
    if (isFinal) {
      push(cursor, fullText.length);
    }
    break;
  }

  return { segments, next: { cursor, sentCount: ordinal } };
}

export function splitCompanionTtsSegmentsIncremental(
  text: string,
  state: IncrementalTtsState,
  isFinal = false,
  opts?: {
    maxSegments?: number;
    maxTotalChars?: number;
    maxSegmentChars?: number;
    /** 首段提前触发的最小字符数（>0 且 sentCount===0 时生效） */
    firstSegmentMinChars?: number;
  },
): IncrementalTtsSplit {
  const maxSegments = opts?.maxSegments ?? TTS_MAX_SEGMENTS;
  const maxTotalChars = opts?.maxTotalChars ?? TTS_MAX_TOTAL_CHARS;
  const maxSegmentChars = opts?.maxSegmentChars ?? TTS_MAX_SEGMENT_CHARS;

  const combined = purifyVoiceText(`${state.rest}${text}`);
  if (combined.length === 0) {
    return { segments: [], next: { ...state, rest: "" } };
  }

  // 15b 二期（问题2 修复）：首段提前——从未发过段且缓冲达到最小长度时，
  // 不要求完整句直接切出首段（声音尽早开始，与流式文字感官同步）。
  // 2026-08-24（三轮自查）：首段同样受单段 160 字符合同上限约束（web 客户端
  // 按 >160 静默丢音频）——此前整个首刷批次（可达 256+ 字符）无上限成段；
  // 超出部分留在 rest，随下一次调用继续正常切句，文本不丢失。
  const firstMin = opts?.firstSegmentMinChars ?? 0;
  if (
    !isFinal && state.sentCount === 0 && firstMin > 0
    // 三轮审查 nit：提前分支同样受总字数配额约束（生产调用方均用默认大配额，
    // 此为防御性守卫；自定义小配额的调用方不再被首段绕过）。
    && combined.length >= firstMin && combined.length <= maxTotalChars
  ) {
    const segText = combined.trim().slice(0, maxSegmentChars);
    const restText = combined.trim().slice(maxSegmentChars);
    if (segText.length > 0) {
      const textSha256 = createHash("sha256").update(segText, "utf8").digest("hex");
      return {
        segments: [{
          ordinal: 1,
          text: segText,
          textSha256,
          segmentId: createHash("sha256")
            .update(`1:${textSha256}`, "utf8")
            .digest("hex"),
        }],
        next: { rest: restText, sentCount: 1, sentChars: segText.length },
      };
    }
  }

  const sentences = combined.split(SPLIT_PATTERN).filter((s) => s.trim().length > 0);
  const last = sentences[sentences.length - 1];
  const lastComplete = isFinal || /[。！？；\n.!?;]$/.test(last.trim());
  const complete = (lastComplete ? sentences : sentences.slice(0, -1))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const rest = lastComplete ? "" : last.trim();

  // 超长句硬切（与全文版一致：HARD_SPLIT_PATTERN 在最近标点/空白切）
  const rawSegments: string[] = [];
  for (const sentence of complete) {
    if (sentence.length <= maxSegmentChars) {
      rawSegments.push(sentence);
      continue;
    }
    let r = sentence;
    while (r.length > maxSegmentChars) {
      const slice = r.slice(0, maxSegmentChars);
      const hardMatch = HARD_SPLIT_PATTERN.exec(slice);
      const cutAt = hardMatch ? hardMatch.index + 1 : maxSegmentChars;
      rawSegments.push(slice.slice(0, cutAt).trim());
      r = r.slice(cutAt).trim();
    }
    if (r.length > 0) rawSegments.push(r);
  }

  const out: CompanionTtsSegment[] = [];
  let total = state.sentChars;
  for (const segText of rawSegments) {
    if (state.sentCount + out.length >= maxSegments) break; // 超段数：只显示文字
    if (total + segText.length > maxTotalChars) break; // 超总字数：只显示文字
    total += segText.length;
    out.push({
      ordinal: state.sentCount + out.length + 1,
      text: segText,
      textSha256: createHash("sha256").update(segText, "utf8").digest("hex"),
      segmentId: "",
    });
  }
  return {
    segments: out.map((seg) => ({
      ...seg,
      segmentId: createHash("sha256")
        .update(`${seg.ordinal}:${seg.textSha256}`, "utf8")
        .digest("hex"),
    })),
    next: {
      rest,
      sentCount: state.sentCount + out.length,
      sentChars: total,
    },
  };
}

/**
 * §11.3 切句：段 ≤160、优先合法标点/空白、final flush。
 */export function splitCompanionTtsSegments(
  text: string,
  opts?: {
    maxSegments?: number;
    maxTotalChars?: number;
    maxSegmentChars?: number;
  },
): CompanionTtsSegment[] {
  const maxSegments = opts?.maxSegments ?? TTS_MAX_SEGMENTS;
  const maxTotalChars = opts?.maxTotalChars ?? TTS_MAX_TOTAL_CHARS;
  const maxSegmentChars = opts?.maxSegmentChars ?? TTS_MAX_SEGMENT_CHARS;

  const purified = purifyVoiceText(text);
  if (purified.length === 0) return [];

  // 先按完整句切；超长句再按硬切标点切
  const sentences = purified.split(SPLIT_PATTERN).filter((s) => s.trim().length > 0);
  const rawSegments: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxSegmentChars) {
      rawSegments.push(sentence.trim());
      continue;
    }
    // 超限：在最近合法标点/空白强制切分
    let rest = sentence;
    while (rest.length > maxSegmentChars) {
      const slice = rest.slice(0, maxSegmentChars);
      const hardMatch = HARD_SPLIT_PATTERN.exec(slice);
      const cutAt = hardMatch ? hardMatch.index + 1 : maxSegmentChars;
      rawSegments.push(slice.slice(0, cutAt).trim());
      rest = rest.slice(cutAt).trim();
    }
    if (rest.length > 0) rawSegments.push(rest.trim());
  }

  // final flush：2026-08-12（语音段落间隔优化）贪心合并相邻句子到目标段长
  // （≤ min(maxSegmentChars, 120)）。此前仅合并 <8 字的短句，导致"每句一段
  // → 每段一次独立 TTS 请求"，段落间隔（合成+网络延迟）被成倍放大；合并后
  // 段内句子由 TTS 自然停顿衔接，朗读更连贯、间隔次数大幅减少。
  // 限制：合并后 ≤ maxSegmentChars（单段 160 上限不变）；目标 120 字符
  // （约 15-18 秒朗读）避免单段过长。超过目标段不强行合并。
  const MERGE_TARGET = Math.min(maxSegmentChars, 120);
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const current = segments[segments.length - 1];
    if (
      current &&
      current.length + raw.length <= MERGE_TARGET &&
      current.length + raw.length <= maxSegmentChars
    ) {
      segments[segments.length - 1] = `${current}${raw}`;
    } else {
      segments.push(raw);
    }
  }

  const out: CompanionTtsSegment[] = [];
  let total = 0;
  for (const segText of segments) {
    if (out.length >= maxSegments) break; // >20 段：只显示文字
    if (total + segText.length > maxTotalChars) break; // >2000 字：只显示文字
    total += segText.length;
    out.push({
      ordinal: out.length + 1,
      text: segText,
      textSha256: createHash("sha256").update(segText, "utf8").digest("hex"),
      segmentId: "",
    });
  }
  // segmentId 由调用方（worker handler）按合同公式
  // sha256(runId:generation:ordinal:textSha256) 填充；此处先用
  // (ordinal:textSha256) 计算确定性占位，避免任何调用方误用明文 text。
  return out.map((seg, i) => ({
    ...seg,
    segmentId: createHash("sha256")
      .update(`${i + 1}:${seg.textSha256}`, "utf8")
      .digest("hex"),
  }));
}

/**
 * §11.3（03 §5.2 line 778）：segmentId 固定为
 * `sha256(runId:generation:ordinal:textSha256)` 的 64 位小写十六进制。
 * 调用方（worker handler）传 runId/generation 与段自身 textSha256。
 */
export function companionSegmentId(
  runId: string,
  generation: number,
  ordinal: number,
  textSha256: string,
): string {
  return createHash("sha256")
    .update(`${runId}:${generation}:${ordinal}:${textSha256}`, "utf8")
    .digest("hex");
}

// ─── 15b 二期：情感与富语言标签（阿里百炼 Qwen-Audio-TTS） ───────────────
// 双文本管线：LLM 输出可嵌入标签（仅 qwen 朗读文本保留），展示/入库文本
// 必须剥离（stripVoiceExpressionTags）；模型表达通过 companion-voice-expression
// 映射到已提交正文的区间，分段播放 cue 与合成标记同源（方案 45）。
// 2026-08-13（引擎兼容）：实现位于 packages/shared/voice-expression-tags
// （api edge 分支净化也需使用），调用方直接从 @astella/shared/voice-expression-tags 导入。
