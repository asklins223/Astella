/**
 * 本轮富块账本：工具结果带回的 nav / quote 等块随终态消息落库。
 *
 * 账本只回答「哪些块已经记过、同一份内容只记一次」；步骤编排负责把工具结果
 * 交进来。恢复时从已持久化的搜索回执补登记引用块，已记过的不再重复。
 */
import type { CompanionContentBlockV1 } from "@astella/shared";
import { canonicalJsonV1 } from "@astella/shared/content-hash";
import { readCompanionWebSearchReceipts, webSearchCitationBlocks } from "../../agent/web-search.ts";

export type CompanionRichBlockLedger = {
  readonly blocks: CompanionContentBlockV1[];
  push(block: CompanionContentBlockV1): void;
  replace(kept: CompanionContentBlockV1[]): void;
};

export function createCompanionRichBlockLedger(initial: readonly CompanionContentBlockV1[]): CompanionRichBlockLedger {
  const blocks = [...initial];
  const keys = new Set(blocks.map(block => canonicalJsonV1(block)));
  const push = (block: CompanionContentBlockV1) => {
    const key = canonicalJsonV1(block);
    if (keys.has(key)) return;
    keys.add(key);
    blocks.push(block);
  };
  return {
    blocks,
    push,
    replace(kept) {
      if (kept.length === blocks.length) return;
      blocks.length = 0;
      keys.clear();
      for (const block of kept) push(block);
    },
  };
}

/** 搜索回执说明服务不可用时，关掉这一轮的联网工具并记下原因。 */
export function markCompanionWebSearchUnavailable(
  event: { constraints: { webSearchEnabled?: boolean }; webSearchUnavailableReason?: string },
  reason: unknown,
): void {
  event.constraints.webSearchEnabled = false;
  event.webSearchUnavailableReason = typeof reason === "string" ? reason : "service_unavailable";
}

/** 从本轮的搜索回执补登记引用块；返回本次新增的搜索次数。 */export async function seedCompanionWebSearchBlocks(input: {
  ledger: CompanionRichBlockLedger;
  workspaceId: string;
  userId: string;
  runId: string;
  recovered: boolean;
  onUnavailable: (reason: unknown) => void;
}): Promise<number> {
  let calls = 0;
  for (const result of await readCompanionWebSearchReceipts(
    { workspaceId: input.workspaceId, userId: input.userId }, input.runId)) {
    if (!input.recovered) {
      calls += 1;
      for (const block of webSearchCitationBlocks(result)) input.ledger.push(block);
    }
    if (result.status === "unavailable") input.onUnavailable(result.reason);
  }
  return calls;
}
