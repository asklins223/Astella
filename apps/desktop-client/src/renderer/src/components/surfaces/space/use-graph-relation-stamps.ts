/**
 * 建议关系上的**本人表态**（2026-09-30 从 `graph-surface.tsx` 抽出）。
 *
 * 39d W8-2 · §11.3。**本地先改、重取在后**：服务端把表态折进 ETag
 * （`topologyRevision` 只哈希两端点与 kind，不含本人的态度），
 * 所以「写完再重取」这一发有可能拿到与上一次**逐字节相同**的 ETag → 304 →
 * 界面什么都不会变。用户在真窗口里看到的是「我按了，什么都没发生，而且没有报错」。
 * **所以这里先按本地结论改边，再在后台重取对齐。**
 *
 * ## 为什么它能独立成一个 hook（而「读者控制状态」那块的邻居不行）
 *
 * 这四行**只是状态**，不发请求、不碰 `useSurfaceProjection` 那条取数链。
 * 真正用到取数结果的是 `stampRelationDecision`（在组件里），
 * 它**读这里的 `relationStamps` 并调这里的 setter**——
 * 所以搬出来之后组件从返回值里拿，**而不是从作用域里引用**。
 *
 * 拆的是位置，不是行为。
 */
import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

export type GraphRelationStamps = {
  epochRef: MutableRefObject<number>;
  stampingEdgeId: string | null;
  relationStamps: Record<string, "confirmed" | "dismissed">;
  relationStampError: string | null;
  setStampingEdgeId: Dispatch<SetStateAction<string | null>>;
  setRelationStamps: Dispatch<SetStateAction<Record<string, "confirmed" | "dismissed">>>;
  setRelationStampError: Dispatch<SetStateAction<string | null>>;
};

export function useGraphRelationStamps(): GraphRelationStamps {
  const epochRef = useRef(0);
  const [stampingEdgeId, setStampingEdgeId] = useState<string | null>(null);
  const [relationStamps, setRelationStamps] = useState<Record<string, "confirmed" | "dismissed">>({});
  const [relationStampError, setRelationStampError] = useState<string | null>(null);

  return {
    epochRef, stampingEdgeId, setStampingEdgeId,
    relationStamps, setRelationStamps,
    relationStampError, setRelationStampError,
  };
}
