import { useCallback, useState } from "react";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";

/**
 * 今日复习那三颗动作（39d W7-4 刀十三；§12 表「今日复习」行）。
 *
 * ## `screenLine` **原样念**，一个字都不拼
 *
 * 那一句由**服务端**按真读数生成（§12 表「剩余需求不伪称完成」）。渲染层自己拼的话，
 * 迟早有一处忘了带「剩下 N 道」——而漏掉的那一处读出来正是「今天完成 3 道」而她手上有
 * 5 道到期。
 *
 * ## 减量的档位**不写死**
 *
 * `reduceBy` 由调用方给（默认 2）。写死一个 2 会在某天她只想减 1 时变成"减 2"，
 * 而屏上只有一颗按钮——**她只能接受一个她没选过的数**。
 */
export function TodayBatchOptions({
  timeZone,
  epochRef,
  initialPaused,
  onResult,
}: {
  timeZone: string;
  epochRef: { current: number | undefined };
  /** 服务端读回来的那一版：这一批此刻是不是停着的。 */
  initialPaused?: boolean;
  onResult?: (result: { action: string; lockedLength: number; paused: boolean; remaining: number; screenLine: string }) => void;
}) {
  // **从服务端已知的 paused 起手**，不是等用户点一次才知道。
  // 此前这里是 null，于是刷新或离开再回来之后：上面写着「这一批先停着」，
  // 下面却还摆着「先停一下」——开关在骗人，而且这一次会话里按它才会翻面。
  const [state, setState] = useState<{ lockedLength: number; paused: boolean; remaining: number; screenLine: string } | null>(
    initialPaused ? { lockedLength: 0, paused: true, remaining: 0, screenLine: "" } : null,
  );
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (action: "reduce" | "pause" | "resume", reduceBy?: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const api = window.ailearn;
      if (!api) return;
      const response = await api.review.actOnTodayBatch({
        meta: createRequestMeta(epochRef.current),
        request: { action, reduceBy, timeZone },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const next = unwrapGatewayResult(response);
      setState(next);
      onResult?.(next);
    } catch {
      // 失败**不更新那一行**：屏上宁可留着上一句，也不显示一个她没按过的结果。
      // 这不是"保守"，是「伪称完成」那一侧——句子里带着一个没发生的数。
    } finally {
      setBusy(false);
    }
  }, [busy, timeZone, epochRef, onResult]);

  return (
    <div className="hud-today-batch">
      {state ? <p className="hud-today-batch__line">{state.screenLine}</p> : null}
      <div className="hud-today-batch__actions">
        <button
          type="button"
          className="hud-desk-next__act"
          onClick={() => void act("reduce", 2)}
          disabled={busy}
        >
          今天少做两道
        </button>
        {state?.paused ? (
          <button
            type="button"
            className="hud-desk-next__act"
            onClick={() => void act("resume")}
            disabled={busy}
          >
            接着做
          </button>
        ) : (
          <button
            type="button"
            className="hud-desk-next__act hud-desk-next__act--quiet"
            onClick={() => void act("pause")}
            disabled={busy}
          >
            先停一下
          </button>
        )}
      </div>
    </div>
  );
}
