import { successfulWebSearchDocuments, type WebSearchDocument, type WebSearchResult, type WebSearchSource } from "../../agent/web-search.ts";
import { CompanionReadBatch } from "./companion-read-batch.ts";
import { classifyCompanionToolFailure } from "./companion-tool-outcome.ts";
import { companionToolFailureFaces } from "./companion-tool-failure-faces.ts";

/** Source order belongs to the successful search receipt. Every page uses the
 * normal authorized reader; one unavailable page does not erase its siblings. */
export async function readCompanionSearchSources(input: {
  result: Extract<WebSearchResult, { status: "succeeded" }>;
  count: number;
  signal: AbortSignal;
  read: (source: WebSearchSource, signal: AbortSignal) => Promise<Record<string, unknown>>;
}): Promise<WebSearchDocument[]> {
  const sources = input.result.sources.slice(0, input.count);
  const read = async (index: number, signal: AbortSignal): Promise<WebSearchDocument> => {
    const source = sources[index]!;
    let document: Record<string, unknown>;
    try { signal.throwIfAborted(); document = await input.read(source, signal); }
    catch (error) {
      signal.throwIfAborted();
      const failure = companionToolFailureFaces(classifyCompanionToolFailure(error, "read", true));
      document = { status: "unavailable", reason: failure.safeSummary };
    }
    return { referenceId: source.referenceId, requestedUrl: source.url, citationMarker: source.citationMarker, document };
  };
  if (sources.length < 2) return sources.length ? [await read(0, input.signal)] : [];
  const batch = new CompanionReadBatch({ count: sources.length, signal: input.signal,
    operation: () => "web.read_document", prepare: async index => index, key: String,
    execute: (index, _value, signal) => read(index, signal) });
  try {
    const documents: WebSearchDocument[] = [];
    for (let index = 0; index < sources.length; index++) {
      input.signal.throwIfAborted();
      documents.push(await (await batch.at(index))!.result);
    }
    return documents;
  } finally { await batch.close(); }
}

/** Keep full search snippets in the durable result_ref. The author's context
 * needs locators plus actual excerpts, not the same snippet again beside a
 * document, nor long unread summaries that look like verified evidence. */
export function compactCompanionSearchResult(result: WebSearchResult): Record<string, unknown> {
  if (result.status !== "succeeded" || !result.documents) return result;
  const read = new Set(successfulWebSearchDocuments(result).map(item => item.referenceId));
  return { ...result, sources: result.sources.map(source => ({ ...source,
    content: read.has(source.referenceId) ? "" : source.content.slice(0, 160),
    readStatus: read.has(source.referenceId) ? "read" : result.documents!.some(item => item.referenceId === source.referenceId) ? "unavailable" : "not_read",
  })), readingGuidance: "只有 documents 中 status=succeeded 的原文窗口是本轮已读证据，使用对应 citationMarker。sources 中 not_read 的摘要只供定位，不能据摘要引用；不足时再读相应网页或用 findText 定位。当前原文足够就回答，不为覆盖所有搜索结果而继续检索。" };
}
