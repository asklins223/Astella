import { proseOutsideCode } from "../tools/companion-tool-protocol-output.ts";

/** Typed value placeholders retained for already supplied structured facts.
 * The host no longer parses a user's wording to choose keys or prefetch values.
 */
export const FACT_SPAN_KEYS = {
  today_minutes: true,
  week_minutes: true,
  card_count: true,
  note_count: true,
  streak_days: true,
} as const;

export type FactSpanKey = keyof typeof FACT_SPAN_KEYS;

export type FactSpanValues = Partial<Record<FactSpanKey, string>>;

/** 只保留有值的键（值缺失 = 这个键这一轮算不出来，不能进目录）。 */
export function pickFactSpanValues(
  source: Partial<Record<FactSpanKey, number | string | null | undefined>>,
  keys: readonly FactSpanKey[],
): FactSpanValues {
  const out: FactSpanValues = {};
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    out[key] = typeof value === "number" ? String(value) : String(value);
  }
  return out;
}

/**
 * 目录块。**只列键与值，不写额外说明**——她已经有一条通用规则（C 层前言）告诉她
 * "要报读数就写 `{{f:key}}`"，这里再写一遍只会把同一句话堆两遍。
 */
export function renderFactSpansBlock(values: FactSpanValues): string | null {
  const keys = Object.keys(values) as FactSpanKey[];
  if (keys.length === 0) return null;
  return [
    "<fact_spans>",
    ...keys.map((key) => `${key} = ${values[key]}`),
    "</fact_spans>",
  ].join("\n");
}

const PLACEHOLDER = /\{\{\s*f:\s*([a-z_]{2,40})\s*\}\}/g;
/** Only the reserved fact namespace is a host placeholder. Ordinary templates remain text. */
const ANY_PLACEHOLDER = /\{\{\s*f(?:\s*:|$)/;
/** 句子切分：把"要丢的那半句"界定在句内，不牵连别的正文。 */
const CLAUSE = /[^。！？!?；;\n]*[。！？!?；;\n]?/g;

export interface FactSpanResolution {
  readonly text: string;
  /** 被丢掉的半句（原文），留给调用方记日志——静默丢弃会让"她怎么少说了一句"无法复盘。 */
  readonly dropped: string[];
}

/**
 * 渲染她正文里的 `{{f:key}}`。
 *
 * - 已知键 → 换成目录里的值（**逐字**，不做任何二次加工）；
 * - 未知键、未闭合的残留 → **丢掉那一句、其余正文照留**（日记那条策略）；
 * - 目录为空时同理：她这一轮没有可报的键，写了就丢。
 */
export function resolveFactSpans(text: string, values: FactSpanValues): FactSpanResolution {
  const prose = proseOutsideCode(text, false).prose;
  if (!ANY_PLACEHOLDER.test(prose)) return { text, dropped: [] };
  const dropped: string[] = [];
  const kept: string[] = [];
  let offset = 0;
  for (const clause of text.match(CLAUSE) ?? []) {
    if (clause.length === 0) continue;
    const visibleClause = prose.slice(offset, offset + clause.length);
    offset += clause.length;
    if (!ANY_PLACEHOLDER.test(visibleClause)) {
      kept.push(clause);
      continue;
    }
    let bad = false;
    const remaining = visibleClause.replace(PLACEHOLDER, (_match, key: string) => {
      if (!Object.hasOwn(values, key) || typeof values[key as FactSpanKey] !== "string") bad = true;
      return "";
    });
    if (bad || ANY_PLACEHOLDER.test(remaining)) {
      dropped.push(clause.trim());
      continue;
    }
    const resolved = clause.replace(PLACEHOLDER, (match, key: string, at: number) =>
      visibleClause.slice(at, at + match.length) === match ? values[key as FactSpanKey]! : match);
    kept.push(resolved);
  }
  return { text: kept.join("").trim(), dropped };
}

/**
 * 流式专用：把结尾**没写完**的那段占位符扣住不下发（`…今天学了{{f:today_min`）。
 *
 * 不扣住的话用户会先看到半个标记、下一拍再看到它变成数字；`sanitizeCompanionVisibleText`
 * 对供应商控制符用的就是同一个办法（`withholdProviderControlTail`）。
 */
export function withholdPartialFactSpanTail(text: string): string {
  const prose = proseOutsideCode(text, true).prose;
  const open = prose.lastIndexOf("{{");
  if (open < 0 || !/^\{\{\s*(?:f\s*(?::[^}]*)?)?$/.test(prose.slice(open))) return text;
  return text.slice(0, open);
}
