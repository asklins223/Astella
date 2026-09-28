import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import type { HomeSuggestionWireV2 } from "@ailearn/shared/review-queue-v2-contracts";
import { useSurfaceProjection } from "./surface-data";

/**
 * 首页「只推一件」的读侧，四档而不是两档。
 *
 * 为什么单独一个投影而不是直接用 `useSurfaceProjection`：那张卡要区分
 * 「正在读」「读到了」「**读不到**」「没有到期的事」四种读数。合成一档之后，
 * 最常见的那个错就回来了——把"读不到"画成"今天没有任务"（§12.1 明确不许：
 * 没有到期需求**不制造**今日任务，但读不到也不等于没有到期需求）。
 */
export type HomeNextStepReadV2 =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "wire"; readonly suggestion: HomeSuggestionWireV2 };

export function useHomeNextStepProjection(): HomeNextStepReadV2 {
  // §12.1 那句「本次」的边界按**她的日历日**算；由客户端带上来，不在服务端猜一次
  // ——按 UTC 猜会在她的午夜前后切错一次，而那一次恰好是"她刚做完今天"的时候。
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data, loading, failure } = useSurfaceProjection(
    async ({ workspaceEpoch }) => unwrapGatewayResult(
      await window.ailearn.review.readHomeSuggestion({
        meta: createRequestMeta(workspaceEpoch),
        timeZone,
      }),
    ),
    [timeZone],
    {},
  );
  if (data) return { kind: "wire", suggestion: data };
  if (failure) return { kind: "unreadable", message: failure };
  return { kind: "loading" };
}
