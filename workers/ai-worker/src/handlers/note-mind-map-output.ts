import { mindMapContentV1Schema, type MindMapContentV1 } from "@astella/shared/note-mind-map-contracts";
import type { ChatMessage } from "@astella/shared";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { logger } from "../lib/logger.ts";
import { NoteMindMapOutputError } from "../lib/non-retryable-errors.ts";
import { buildRepairAttempt, repairInstruction } from "../lib/model-repair-attempt.ts";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { exactQuote, type SourceBlock } from "./note-mind-map-source.ts";

/** 重试时给模型的修正要求：点名这一处到底哪里没过，泛泛一句它无从下手。 */
function repairPrompt(detail: string | null): string {
  return repairInstruction(detail, "请重新检查唯一根节点、父子关系与逐字引用。");
}

/**
 * 重试那一发的对话组装（形状与拓展那两步共用，见 lib/model-repair-attempt）。
 *
 * 提示里写着"只修正这一处、其余保持不变"——可"其余"只在它刚交出去的那份 JSON 里。
 * 实测（2026-10-14《瑞利散射与天空的颜色》）不带上一版时连发两版都把同一句引文的
 * blockOrdinal 写成隔壁那一段，一发烧两次调用仍然判红。
 */
export function buildMindMapRepairAttempt(
  request: readonly ChatMessage[],
  rejectedOutput: string | null,
  detail: string | null,
): ChatMessage[] {
  return buildRepairAttempt(request, rejectedOutput, repairPrompt(detail));
}
/** 报错里带一小段原文，够模型认出是哪一条，又不至于把消息撑爆。 */
function brief(value: string, limit = 40): string {
  const chars = Array.from(value.trim());
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
}

/**
 * 模型自己用省略号截短的那一句，还原成它引用的那段真前缀。
 *
 * 实测（2026-10-14，37 万字符长文的脑图）：节点引第 42 段的
 * 「AgentRun | 原目标、当前目标 revision、完成条件、输入引用、范…」——去掉末尾那个
 * 省略号，前面逐字都对得上原文。长表格与长论证里模型习惯"引一半加省略号"，而核对要
 * 逐字，于是整张图判无效、两次调用全烧掉，用户看到的是"这次没有生成"。
 * 省略号不是内容，是"后面还有"的记号：去掉之后剩下的那一段仍然必须由 `exactQuote`
 * 在原文里逐字定位，且只认唯一命中——既没有放行编造，也没有猜出处。
 * 短到 8 个字以下就不认了：那样的前缀在哪一段都可能出现，撑不起一个知识点。
 */
function untruncatedQuoteV1(quote: string): string | null {
  let value = quote.trimEnd();
  while (value.endsWith("…") || value.endsWith(".")) value = value.slice(0, -1).trimEnd();
  const chars = Array.from(value);
  return chars.length >= 8 ? chars.join("") : null;
}

/**
 * 引文是真的、门牌号写错时，按逐字命中的那一段归位（只在唯一命中时）。
 *
 * 模型最常见的错法不是编引文，而是把列表内容记在它上方那个小标题的块号上——
 * 语义联想合理，编号就是错的。实测（2026-10-14《瑞利散射与天空的颜色》）连发三版
 * 都在这一类上翻车：repair 修好被点名的那一处，下一处又犯同样的错，一发烧两次
 * 调用仍然判红。而「这句到底在哪一段」服务端是**算得出来**的事实，不是猜测：
 * 归位后读者看到的出处与原文一致；算不出唯一答案（零处或多处命中）就照旧判红，
 * 并把候选段号说给模型。每一次归位都记进日志，不留静默改动。
 */
export function parseMindMap(raw: string, sources: readonly SourceBlock[]): MindMapContentV1 {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["schemaVersion", "rootId", "nodes"]); }
  catch { throw new NoteMindMapOutputError("脑图不是有效 JSON"); }
  const parsed = mindMapContentV1Schema.safeParse(value);
  if (!parsed.success) {
    // 带上第一条问题与它的路径：重试提示要靠它指出该改哪一处，
    // 只说"结构不完整"模型只能把同一张图原样再交一遍。
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `（${issue.path.join(".")}）` : "";
    throw new NoteMindMapOutputError(`脑图结构不完整或缺少原文依据：${issue?.message ?? "未通过校验"}${where}`);
  }
  const byOrdinal = new Map(sources.filter(b => b.type !== "image").map(b => [b.ordinal, b]));
  const searchable = sources.filter(b => b.type !== "image");
  // 核对与落库都用**渲染后的那一句**：笔记页面上读者看到的是「关键关系（近似）：散射强度…」，
  // 不是带 `**`、`- ` 的 markdown 源码。扩展那条链早就这么存了（noteBlockRenderedTextV1），
  // 这里对齐——同一个口径只有一份：底本先渲染，再在渲染结果上逐字定位（图片节点不出文字，
  // 所以 `![固定电压](…)` 这种"图里恰好有这几个字"仍然核不过）。
  const renderOf = (block: SourceBlock) => noteBlockRenderedTextV1(block.type, block.content);
  /** 在一个候选底本上逐字定位；命中几段就返回几段，零或一段以上都由调用方判红。 */
  const findIn = (needle: string, blocks: readonly SourceBlock[]) => blocks
    .map((block) => ({ ordinal: block.ordinal, quote: exactQuote(renderOf(block), needle) }))
    .filter((hit): hit is { ordinal: number; quote: string } => hit.quote !== null);
  return { ...parsed.data, nodes: parsed.data.nodes.map(node => ({ ...node,
    references: node.references.flatMap(ref => {
      const source = byOrdinal.get(ref.blockOrdinal);
      // 先按模型交来的整句核对；只有它自己截了短（末尾省略号）才退而认那段真前缀。
      const candidates: { needle: string; truncated: boolean }[] = [{ needle: ref.quote, truncated: false }];
      const prefix = untruncatedQuoteV1(ref.quote);
      if (prefix !== null && prefix !== ref.quote.trim()) candidates.push({ needle: prefix, truncated: true });
      // 判红的那一句要说的是**最有信息量**的那次命中：整句没在原文里出现（0 处）时，
      // 如果它截短后的前缀同时落在好几段，那才是模型真正要面对的问题（该引哪一段）。
      let ambiguous: readonly { ordinal: number }[] = [];
      for (const { needle, truncated } of candidates) {
        const onClaimed = source === undefined ? [] : findIn(needle, [source]);
        // 归位搜索与直接核对同一份底本，两处才会同一个答案。
        const hits = onClaimed.length === 1 ? onClaimed : findIn(needle, searchable);
        const relocated = onClaimed.length !== 1 && hits.length === 1;
        if (hits.length === 0) continue;
        if (hits.length > 1) {
          if (ambiguous.length === 0) ambiguous = hits;
          continue;
        }
        const chosen = hits[0]!;
        if (relocated) {
          logger.warn(
            { nodeId: node.id, claimedBlockOrdinal: ref.blockOrdinal, actualBlockOrdinal: chosen.ordinal },
            "mind map quote relocated to the paragraph that actually contains it",
          );
        }
        if (truncated) {
          logger.warn(
            { nodeId: node.id, blockOrdinal: chosen.ordinal, keptChars: Array.from(chosen.quote).length, claimed: brief(ref.quote) },
            "mind map quote kept as the verbatim prefix the model abbreviated with an ellipsis",
          );
        }
        return [{ blockOrdinal: chosen.ordinal, quote: chosen.quote }];
      }
      throw new NoteMindMapOutputError(
        `脑图引用无法在读取的段落中核对：节点 ${node.id} 引用第 ${ref.blockOrdinal} 段的「${brief(ref.quote)}」`
        + (ambiguous.length === 0
          ? "（这句在读取过的段落里没有逐字一致的原文，请换一句真的）"
          : `（这句同时出现在段落 ${ambiguous.map(hit => hit.ordinal).join("、")}，请任选其一）`),
      );
    }),
  })) };
}

export function reconcileMergedMindMap(map: MindMapContentV1, parts: readonly MindMapContentV1[]): MindMapContentV1 {
  const concepts = new Map(parts.flatMap(p => p.nodes.filter(n => n.kind === "concept")).map(n => [n.id, n]));
  const actual = map.nodes.filter(n => n.kind === "concept");
  const missing = [...concepts.keys()].filter(id => !actual.some(n => n.id === id));
  if (actual.length !== concepts.size || missing.length > 0) {
    throw new NoteMindMapOutputError(`合并脑图遗漏了已读取的知识节点：${missing.slice(0, 5).join("、") || "数量对不上"}。每个 concept 都必须原样保留，只能改 parentId`);
  }
  const checked = mindMapContentV1Schema.safeParse({ ...map, nodes: map.nodes.map(n => {
    if (n.kind === "concept") return { ...concepts.get(n.id)!, parentId: n.parentId };
    // The merge step may organize topics, but cannot add uncited factual explanations.
    return { ...n, explanation: null, references: [] };
  }) });
  if (!checked.success) throw new NoteMindMapOutputError("合并脑图结构没有通过校验");
  return checked.data;
}

