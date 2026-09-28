/**
 * 书桌上那**一件**（39d W7-4 刀八；39 §12.1）。
 *
 * ## 这一层只做两件事
 *
 *  1. 把 wire **照着画**（两棵树：有建议 ⇒ 一张纸签；没建议 ⇒ 三个入口）。
 *  2. 把两颗按钮**按下去**（换一个／暂不处理），并用回执里那**下一件**就地替换——
 *     不重发读、不空一下再刷。
 *
 * **排序与取舍全在服务端**（刀四的判据）。渲染层不再排一次：两处排就是两个首页。
 *
 * ## 三条屏上纪律
 *
 *  - **`swappableCount === 0` ⇒ 那颗「换一个」不画。** 画一颗按了没反应的按钮，
 *    比没有更坏——它会让整张纸签显得不可信。
 *  - **`nothing_due` 时画的是**入口**，不是「今天没有任务」以外的建议。** §12.1
 *    「没有到期需求不制造『今日任务』」——所以那一档里没有一个按钮叫"随便做点什么"。
 *  - **伴星不因这一层消失。** AGENTS.md：进入学习空间的页面默认保留可见的 Live2D
 *    伴星与稳定座位；这一层只在**书桌**上放一张纸签，不碰房间构图。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";

type HomeSuggestion =
  | { kind: "suggested"; itemKey: string; kindOfItem: "user_named" | "unfinished_run" | "authorized_review"; headline: string; reasonLine: string; swappableCount: number }
  | { kind: "nothing_due"; emptyActions: Array<"new_note" | "write_from_source" | "resume_reading"> };

const EMPTY_LABEL: Record<"new_note" | "write_from_source" | "resume_reading", string> = {
  new_note: "新建笔记",
  write_from_source: "从资料写笔记",
  resume_reading: "继续最近读的",
};

export interface HomeSuggestionProps {
    /**
   * 她的时区。**由设置里那一项读出来**，不在本层猜——§12.1 那句「用户略过后**本次**
   * 不反复推荐同一项」的「本次」按**她的日历日**算（0306），而按 UTC 或本机时区算会在
   * 她的午夜前后切错一次——**而那一次恰好是「她刚做完今天」的时候**。
   */
  timeZone: string;
  epochRef: { current: number | undefined };
  onOpenNote?: (noteId: string) => void;
  onNewNote?: () => void;
}

export function HomeSuggestionCard({ timeZone, epochRef, onNewNote }: HomeSuggestionProps) {
  const [suggestion, setSuggestion] = useState<HomeSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  // 「换一个」之后**要记住被换掉的那一项**，否则连按两下会跳回原来那件。
  const swappedRef = useRef<string[]>([]);

  const load = useCallback(async () => {
    try {
      const api = window.ailearn;
      if (!api) return;
      const response = await api.review.readHomeSuggestion({
        meta: createRequestMeta(epochRef.current),
        timeZone,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setSuggestion(unwrapGatewayResult(response));
    } catch {
      // 读不出来就**不画一张空的纸签**——那等于屏上凭空多一句"今天没有任务"，
      // 而那一句是 §12.1 明写不许制造的。null ⇒ 什么都不画。
      setSuggestion(null);
    }
  }, [timeZone, epochRef]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (action: "swapped" | "dismissed") => {
    if (!suggestion || suggestion.kind !== "suggested" || busy) return;
    setBusy(true);
    try {
      const api = window.ailearn;
      if (!api) return;
      const response = await api.review.actOnHomeSuggestion({
        meta: createRequestMeta(epochRef.current),
        request: { itemKey: suggestion.itemKey, action, timeZone },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      // 回执**顺带**交回下一件：就地替换，不重发读、不空一下再刷。
      const next = unwrapGatewayResult(response).suggestion;
      if (action === "swapped") swappedRef.current = [...swappedRef.current, suggestion.itemKey];
      setSuggestion(next);
    } catch {
      // 失败就**恢复原状**而不是留在"按过了"的样子：屏上不能显示一件她没同意换掉的事。
      await load();
    } finally {
      setBusy(false);
    }
  }, [suggestion, busy, timeZone, epochRef, load]);

  if (suggestion === null) return null;

  // §12.1「没有到期需求不制造『今日任务』」——这一档画的是**入口**。
  if (suggestion.kind === "nothing_due") {
    return (
      <section className="hud-desk-elsewhere" aria-label="现在可以做的">
        <ul className="hud-desk-elsewhere__list">
          {suggestion.emptyActions.map((action) => (
            <li key={action}>
              <button
                type="button"
                className="hud-desk-elsewhere__entry"
                onClick={action === "new_note" ? onNewNote : undefined}
              >
                {EMPTY_LABEL[action]}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="hud-desk-next" aria-label="现在值得做的一件事" data-slot="desk">
      <p className="hud-desk-next__headline">{suggestion.headline}</p>
      {/* §12.1「推荐附一句理由」——**必填**那一格就画在这里；空的那一条服务端不会送来。 */}
      <p className="hud-desk-next__reason">{suggestion.reasonLine}</p>
      <div className="hud-desk-next__actions">
        <button
          type="button"
          className="hud-desk-next__act"
          onClick={() => void act("swapped")}
          disabled={busy}
          // 0 ⇒ **不画**，而不是画一颗按了没反应的（那会让整张纸签显得不可信）。
          hidden={suggestion.swappableCount === 0}
        >
          换一个
        </button>
        <button
          type="button"
          className="hud-desk-next__act hud-desk-next__act--quiet"
          onClick={() => void act("dismissed")}
          disabled={busy}
        >
          暂不处理
        </button>
      </div>
    </section>
  );
}

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
  onResult,
}: {
  timeZone: string;
  epochRef: { current: number | undefined };
  onResult?: (result: { action: string; lockedLength: number; paused: boolean; remaining: number; screenLine: string }) => void;
}) {
  const [state, setState] = useState<{ lockedLength: number; paused: boolean; remaining: number; screenLine: string } | null>(null);
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
