import { useCallback, useState } from "react";
import { RefreshCw, Shuffle, X } from "lucide-react";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import type { HomeSuggestionWireV2 } from "@ailearn/shared/review-queue-v2-contracts";
import { useSurfaceProjection } from "./surface-data";

/**
 * 首页「只推一件」（39 §12.1 第一段）。
 *
 * ## 这条链之前是**整条没有渲染层**的
 *
 * `readHomeSuggestionV2` / `actOnHomeSuggestionV2` 从服务、路由、IPC 到 preload
 * 都齐了，合同连"理由必填非空""swappableCount 为 0 时那颗按钮不画"都写死了——
 * 但渲染层一个调用都没有。于是 §12.1 那两句最要紧的产品承诺，一句也没兑现：
 *  - 「推荐附一句理由，可换一个或暂不处理」——**换一个／暂不处理两颗按钮不存在**；
 *  - 「用户略过后本次不反复推荐同一项」——没有那次"略过"，也就没有那条规则。
 *
 * 首页继续显示的是另一份投影（`home-presentation.ts` 的 `title`/`primaryLabel`），
 * 两份来源各说各的。这一份组件把**真正有依据的那份**接上。
 *
 * ## 三条读法上的纪律
 *
 *  1. **理由一个字都不改写**：它是服务端按真读数生成的，空理由就是一句没有出处的断言。
 *  2. **换一个**只在 `swappableCount > 0` 时画——画一颗按了没反应的按钮比不画更糟。
 *  3. **读失败不画"今天没有任务"**（§12.1）：那是把"读不到"说成"没有"，两件事不一样。
 */
export function HomeNextStep({
  timeZone,
  epochRef,
  onOpen,
}: {
  timeZone: string;
  epochRef: { current: number | undefined };
  /** 点那张建议本身：按它到底是哪一类，走该走的那条路。 */
  onOpen: (kind: Extract<HomeSuggestionWireV2, { kind: "suggested" }>) => void;
}) {
  const [override, setOverride] = useState<HomeSuggestionWireV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);

  const {
    data,
    loading,
    failure,
    reload,
  } = useSurfaceProjection(
    async ({ workspaceEpoch }) => unwrapGatewayResult(
      await window.ailearn.review.readHomeSuggestion({
        meta: createRequestMeta(workspaceEpoch),
        timeZone,
      }),
    ),
    [timeZone],
    {},
  );

  // 动作回执顺带交回下一件，所以这里覆盖读结果，不必再发一次读。
  const suggestion = override ?? data;

  const act = useCallback(async (
    itemKey: string,
    action: "swapped" | "dismissed",
  ) => {
    const api = window.ailearn;
    if (!api || busy) return;
    setBusy(true);
    setActionFailure(null);
    try {
      const result = unwrapGatewayResult(await api.review.actOnHomeSuggestion({
        meta: createRequestMeta(epochRef.current),
        request: { itemKey, action, timeZone },
      }));
      setOverride(result.suggestion);
    } catch (error) {
      // 这一次动作**看得见地**失败：否则那颗按钮按下去什么也没发生，
      // 与一颗死按钮没有区别。
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [busy, epochRef, timeZone]);

  if (loading && !suggestion) {
    return <p className="home-next-step home-next-step--quiet" role="status">正在看今天真正停下的位置…</p>;
  }
  if (failure && !suggestion) {
    return (
      <p className="home-next-step home-next-step--quiet" role="note">
        今天的位置暂时读不到。
        <button type="button" className="text-action" onClick={() => void reload()}>
          <RefreshCw size={13} aria-hidden="true" />再读一次
        </button>
      </p>
    );
  }
  if (!suggestion) return null;

  if (suggestion.kind === "nothing_due") {
    // §12.1「没有任务时提供新建笔记、从资料写笔记和最近阅读入口。
    // 没有记录不显示假统计，没有到期需求不制造"今日任务"」——
    // 所以这一档给的是入口，一句建议都不给。
    return (
      <div className="home-next-step home-next-step--empty" data-home-next-step="nothing_due">
        <p>今天没有到期的事。可以从下面几处接着来：</p>
        <ul>
          {suggestion.emptyActions.includes("new_note") ? <li key="new_note">新建一篇笔记</li> : null}
          {suggestion.emptyActions.includes("write_from_source") ? <li key="write_from_source">从资料写一篇笔记</li> : null}
          {suggestion.emptyActions.includes("resume_reading") ? <li key="resume_reading">接着读最近那篇</li> : null}
        </ul>
      </div>
    );
  }

  return (
    <div className="home-next-step" data-home-next-step="suggested">
      <p className="home-next-step__head">{suggestion.headline}</p>
      {/* 理由由服务端给，渲染层一个字不改写。 */}
      <p className="home-next-step__reason" data-home-next-step-reason="true">{suggestion.reasonLine}</p>
      {actionFailure ? <p className="home-next-step__failure" role="alert">{actionFailure}</p> : null}
      <div className="home-next-step__actions">
        <button
          type="button"
          className="hud-desk-next__act"
          disabled={busy}
          onClick={() => onOpen(suggestion)}
        >
          就做这个
        </button>
        {suggestion.swappableCount > 0 ? (
          <button
            type="button"
            className="hud-desk-next__act"
            disabled={busy}
            onClick={() => void act(suggestion.itemKey, "swapped")}
          >
            <Shuffle size={13} aria-hidden="true" />换一个
          </button>
        ) : null}
        <button
          type="button"
          className="hud-desk-next__act"
          disabled={busy}
          onClick={() => void act(suggestion.itemKey, "dismissed")}
        >
          <X size={13} aria-hidden="true" />暂不处理
        </button>
      </div>
    </div>
  );
}
