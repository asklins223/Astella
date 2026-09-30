/**
 * 今日复习那一批（39d W7-4 刀十五；39 §12 表「今日复习」行）。
 *
 * ## 这一屏**逐项**念出选择原因
 *
 * 那一行第二列是「一批有限任务，**展示选择原因**」。「展示」是判据，所以每道都要有
 * 一行理由——而不是屏上只说"今天 5 道"。理由由**服务端**给（刀一的判据 ＋ 刀十四的
 * wire），这一层**一个字都不改写**：改写就是"屏上编一个理由"。
 *
 * ## 「今天先到这里」那一行的存在
 *
 * §9.4 末段：「系统结束本批后可以看到『今天先到这里；另外还有可回访内容』」。那个
 * `deferredCount` 由服务端给，而**0 的时候这一行整个不画**——0 的时候画一句"另外还有
 * 0 道可回访"是 §12.1「没有到期需求不制造『今日任务』」的同一种毛病。
 *
 * ## 挂在 `resumable` 那一页里，**不新开一个 surface id**
 *
 * `room-machine.ts` 的 `RoomSurface` 是**全房间共享**的枚举，而它此刻可能正被并行会话
 * 改（handoff §6.2 记过主进程那几个文件是他们的热区）。为一个读侧新开一个 id 要动它，
 * 换来的是一次合并冲突的风险。所以这一屏挂在 `resumable` 那一页**之内**——那一页本来
 * 就是"今天还有哪些没做完"，内容相邻而不是硬塞。**这一条是取舍，不是终局**。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { TodayBatchOptions } from "./HomeSuggestionCard.tsx";

type BatchItem = { objectiveId: string; reason: "due_now" | "rotation_stale" | "user_asked_more"; reasonLine: string };
type Batch = { items: BatchItem[]; lockedLength: number; deferredCount: number; paused: boolean };

const REASON_LABEL: Record<BatchItem["reason"], string> = {
  due_now: "到期",
  rotation_stale: "久未回访",
  user_asked_more: "你加了量",
};

export function TodayBatchSurface({
  timeZone,
  epochRef,
}: {
  timeZone: string;
  epochRef: { current: number | undefined };
}) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [readFailed, setReadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = window.ailearn;
      if (!api) return;
      const response = await api.review.readTodayBatch({
        meta: createRequestMeta(epochRef.current),
        timeZone,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setBatch(unwrapGatewayResult(response));
      setReadFailed(false);
    } catch {
      // 读不出来 ⇒ **不画一个空的「今天没有任务」框**（§12.1 不许制造那一句）。
      setReadFailed(true);
    }
  }, [timeZone, epochRef]);

  useEffect(() => { void load(); }, [load]);

  if (readFailed) {
    return (
      <section className="hud-batch" aria-label="今日复习">
        <p className="hud-batch__line">今天这一批暂时读不出来。</p>
        <button type="button" className="hud-desk-next__act" onClick={() => void load()}>再试一次</button>
      </section>
    );
  }
  if (!batch) return null;

  return (
    <section className="hud-batch" aria-label="今日复习">
      <h2 className="hud-batch__title">今天这一批</h2>
      {batch.paused ? (
        // 停着的时候**照列**——停着的那一批里"有几道"仍然是那几道。空一个框等于说
        // "今天没有任务"，那是 §12.1 明写不许制造的那一句。
        <p className="hud-batch__line">这一批先停着，做到这儿。</p>
      ) : null}
      <ol className="hud-batch__list">
        {batch.items.map((item) => (
          <li key={item.objectiveId} className="hud-batch__item">
            <span className="hud-batch__tag">{REASON_LABEL[item.reason]}</span>
            {/* 理由**逐字念**：改写就是"屏上编一个理由"。 */}
            <span className="hud-batch__why">{item.reasonLine}</span>
          </li>
        ))}
      </ol>
      {/* §9.4 末段那个数。**0 的时候整行不画**——画一句「另外还有 0 道可回访」是
          「没有到期需求不制造『今日任务』」的同一种毛病。 */}
      {batch.deferredCount > 0 ? (
        <p className="hud-batch__line">今天先到这里；另外还有 {batch.deferredCount} 道可回访。</p>
      ) : null}
      <TodayBatchOptions
        timeZone={timeZone}
        epochRef={epochRef}
        // 这一批此刻停没停，父层已经从服务端读到了（`batch.paused`）。不递给它，
        // 那颗开关就只能等用户点一次才知道自己该是"停一下"还是"接着做"——
        // 刷新之后必然读反。
        initialPaused={batch.paused}
        onResult={() => { void load(); }}
      />
    </section>
  );
}
