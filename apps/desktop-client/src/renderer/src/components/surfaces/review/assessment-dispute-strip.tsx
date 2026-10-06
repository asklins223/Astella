/**
 * 判定的异议（39 §14.2、§16.11、§16.25；39d W5-5 界面那一半）。
 *
 * **为什么它此前不存在**：服务端 `run-dispute-routes.ts` 六条齐了、`server.ts:380`
 * 也注册了，而结果页已经印着「也可以现在结束争议、把这一项暂不安排」——那句话
 * 向用户**承诺了一个点不到的地方**。§16.11（无来源观点与争议答案）、§16.22、
 * §16.25（系统误判与用户补答）三条验收都要求用户能提出或查看异议，按现状
 * 它们不是"没做好"，是**无法验收**。这一条纸签把那三句话接上。
 *
 * 三条产品约束直接决定了这块的形状：
 *
 *  1. **理由要念得出来**（§14.2 明写"界面要能念出理由"）。所以已开的一份把
 *     种类、理由、补充、复核结论、更正**逐条列出来**，而不是只给一个"你有异议"。
 *  2. **不能反复要求用户接受同一判定**（§14.2）。所以已经复核过的那一档
 *     （`upheld` / `corrected` / `closed_held`）不再提供"再复核"的暗示；
 *     `recheck_undetermined` 保留补充说明，因为那正是"维持之后用户再补充"。
 *  3. **"结束并暂不安排"是一颗按钮上的两格**，不是两颗按钮。`hold_unavailable`
 *     那一档要**如实说**："争议结束了，但这一项没能设成暂不安排"——显示成
 *     "已暂不安排"就是假回执（§14.2 的出口是"可结束"，让用户走不掉是更坏的失败）。
 *
 * 样式沿用动森式 HUD 的暖纸纸签（`.assessment-dispute-strip`），不是管理台表单。
 * 伴星常驻不受影响：这块是结算纸面内的一张便签，不占伴星座位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assessmentDisputeSurfaceCopyV2,
  type AssessmentDisputeKindV2,
  type AssessmentDisputeViewV2,
  type CloseAssessmentDisputeResultV2,
} from "@astella/shared/assessment-dispute-rules-v2";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client.ts";

/**
 * 四种异议（`AssessmentDisputeKindV2`）在界面上的说法。
 *
 * 四个都留着而不是合成一个"我不满意"：§14.2 的复核要分方向——"题目有问题"要去
 * 核题面、"我的意思被误解"要去核原回答。合成一个标签之后，复核台就不知道该往
 * 哪边查，而那正是这一格存在的理由。
 */
const disputeKindLabels: Record<AssessmentDisputeKindV2, string> = {
  explanation_faulty: "解释不对",
  item_faulty: "题目有问题",
  misunderstood: "我的意思被误解",
  misjudged: "系统判错了",
};

const disputeKindOrder: readonly AssessmentDisputeKindV2[] = [
  "explanation_faulty",
  "item_faulty",
  "misunderstood",
  "misjudged",
];

/** 更正那两档的说法（§16.25：纠正系统误判 vs 用户后来补了条件，是两件事）。 */
const correctionKindLabels = {
  system_misjudgment: "纠正了系统误判",
  user_supplement: "你补充之后的表现",
} as const;

function desktopApi() {
  return typeof window === "undefined" ? undefined : window.astella;
}

function formatStamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "时间未提供";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly dispute: AssessmentDisputeViewV2 | null }
  | { readonly phase: "failed"; readonly message: string };

export interface AssessmentDisputeStripProps {
  /** `snapshot.activeAssessment.assessmentId`；没有就整块不渲染。 */
  readonly assessmentId: string;
  /** `createRequestMeta` 的入参就是它；未取到时是 `undefined`（主进程会自己补当前纪元）。 */
  readonly workspaceEpoch: number | undefined;
  /** 服务端回执带新纪元时交给上层换掉（切空间之后带着旧纪元回来会被主进程拒掉）。 */
  readonly onWorkspaceEpoch?: (epoch: number) => void;
}

export function AssessmentDisputeStrip({ assessmentId, workspaceEpoch, onWorkspaceEpoch }: AssessmentDisputeStripProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState<null | "open" | "supplement" | "close">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [kind, setKind] = useState<AssessmentDisputeKindV2>("explanation_faulty");
  const [statement, setStatement] = useState("");
  const [supplementing, setSupplementing] = useState(false);
  const [supplement, setSupplement] = useState("");
  const [holdObjective, setHoldObjective] = useState(true);
  const epochRef = useRef(workspaceEpoch);
  epochRef.current = workspaceEpoch;

  /**
   * 每次都重读，不缓存。
   *
   * §9.5："历史回放、重新打开结果和刷新页面均无新的学习或调度影响"——这一发是
   * 纯读，所以重读是安全的；而缓存一份会让"另一处已经结束争议"这件事在屏上
   * 迟迟不消失。`assessmentId` 变（换了一轮、换了一次判定）时重新读。
   */
  const reload = useCallback(async () => {
    const api = desktopApi();
    if (!api) return;
    setState({ phase: "loading" });
    try {
      const response = await api.assessmentDispute.get({
        meta: createRequestMeta(epochRef.current),
        assessmentId,
      });
      if (response.workspaceEpoch) onWorkspaceEpoch?.(response.workspaceEpoch);
      // 信封是 `{version, dispute}`，本组件要的是里面那一层。少写 `.dispute` 会让
      // `state.dispute` 变成信封本身，于是每一条理由都读成 undefined——而屏幕上
      // 看上去只是"理由是空的"，不会红。
      setState({ phase: "ready", dispute: unwrapGatewayResult(response).dispute });
    } catch (error) {
      // 读不到**就说读不到**（§13.4）：这里不能静默当成"没有异议"，
      // 那会让一颗"我有异议"的入口在网络坏掉时消失，而用户以为系统没记录。
      setState({ phase: "failed", message: gatewayErrorMessage(error) });
    }
  }, [assessmentId, onWorkspaceEpoch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const copy = useMemo(
    () => (state.phase === "ready" && state.dispute ? assessmentDisputeSurfaceCopyV2(state.dispute) : null),
    [state],
  );

  /** 结束那一发的三档话术，逐档不同——没有哪一档可以显示成"已完成"。 */
  const closeOutcomeCopy = (result: CloseAssessmentDisputeResultV2): string => {
    const dismissed = result.dismissedPendingSchedules;
    const undone = dismissed > 0 ? `顺手撤下了此刻排着的 ${dismissed} 条回访。` : "";
    if (result.outcome === "hold_objective") return `这份异议已结束，这一项已设为「暂不安排」。${undone}`;
    if (result.outcome === "hold_unavailable") {
      return "这份异议已结束。这一项没能设成「暂不安排」——它没有可以挂靠的笔记，下次仍可能出现在复习里。";
    }
    return `这份异议已结束，复习安排保持原样。${undone}`;
  };

  const submitOpen = async () => {
    const api = desktopApi();
    if (!api || busy) return;
    const trimmed = statement.trim();
    if (trimmed.length === 0) {
      setFailure("先写一句为什么不同意，这次判定才会进入复核。");
      return;
    }
    setBusy("open");
    setFailure(null);
    setNotice(null);
    try {
      const response = await api.assessmentDispute.open({
        meta: createRequestMeta(epochRef.current),
        request: { assessmentId, kind, statement: trimmed },
      });
      if (response.workspaceEpoch) onWorkspaceEpoch?.(response.workspaceEpoch);
      // `created: false` 也要说清楚：那不是"又开了一份"，是原来就开着这一份。
      setNotice(unwrapGatewayResult(response).created ? "异议已经记下，这次先不推进复习。" : "这份异议已经开着，仍然有效。");
      setComposing(false);
      setStatement("");
      await reload();
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const submitSupplement = async (text: string) => {
    const api = desktopApi();
    if (!api || busy) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setFailure("补充说明还是空的，写一句再提交。");
      return;
    }
    setBusy("supplement");
    setFailure(null);
    setNotice(null);
    try {
      const response = await api.assessmentDispute.supplement({
        meta: createRequestMeta(epochRef.current),
        request: { assessmentId, supplement: trimmed },
      });
      if (response.workspaceEpoch) onWorkspaceEpoch?.(response.workspaceEpoch);
      unwrapGatewayResult(response);
      setNotice("补充说明已记下；已落库的复核结论不会被重开。");
      setSupplementing(false);
      setSupplement("");
      await reload();
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const submitClose = async () => {
    const api = desktopApi();
    if (!api || busy) return;
    setBusy("close");
    setFailure(null);
    setNotice(null);
    try {
      const response = await api.assessmentDispute.close({
        meta: createRequestMeta(epochRef.current),
        request: { assessmentId, holdObjective },
      });
      if (response.workspaceEpoch) onWorkspaceEpoch?.(response.workspaceEpoch);
      setNotice(closeOutcomeCopy(unwrapGatewayResult(response)));
      await reload();
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  if (state.phase === "loading") {
    return (
      <section className="assessment-dispute-strip" data-state="loading" aria-live="polite">
        <p className="assessment-dispute-strip__hint">正在读这次判定有没有异议…</p>
      </section>
    );
  }

  if (state.phase === "failed") {
    return (
      <section className="assessment-dispute-strip" data-state="failed">
        <b>没能读到这次判定的异议记录</b>
        <p className="assessment-dispute-strip__hint">{state.message}</p>
        <button type="button" className="button" onClick={() => void reload()}>再读一次</button>
      </section>
    );
  }

  const dispute = state.dispute;
  if (!dispute) {
    return (
      <section className="assessment-dispute-strip" data-state="none">
        {notice ? <p className="assessment-dispute-strip__notice" role="status">{notice}</p> : null}
        {failure ? <p className="assessment-dispute-strip__failure" role="alert">{failure}</p> : null}
        {composing ? (
          <div className="assessment-dispute-strip__form">
            <b>哪一处不对？</b>
            <div className="assessment-dispute-strip__kinds" role="radiogroup" aria-label="异议的种类">
              {disputeKindOrder.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  className="assessment-dispute-strip__kind"
                  data-selected={kind === value}
                  onClick={() => setKind(value)}
                >
                  {disputeKindLabels[value]}
                </button>
              ))}
            </div>
            <label className="assessment-dispute-strip__label" htmlFor="assessment-dispute-statement">
              为什么不同意（必填）
            </label>
            <textarea
              id="assessment-dispute-statement"
              value={statement}
              maxLength={2000}
              rows={3}
              placeholder="写下你觉得不对的那一处；你的原话会一起保留。"
              onChange={(event) => setStatement(event.target.value)}
            />
            <div className="assessment-dispute-strip__actions">
              <button type="button" className="button primary" disabled={busy !== null} onClick={() => void submitOpen()}>
                {busy === "open" ? "正在记下…" : "记下这份异议"}
              </button>
              <button type="button" className="button" disabled={busy !== null} onClick={() => { setComposing(false); setFailure(null); }}>
                先不提交
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="button assessment-dispute-strip__open" onClick={() => { setComposing(true); setFailure(null); }}>
            我不同意这次判定
          </button>
        )}
      </section>
    );
  }

  const canClose = dispute.status === "open" || dispute.status === "recheck_undetermined";

  return (
    <section className="assessment-dispute-strip" data-state="open" data-status={dispute.status}>
      <header className="assessment-dispute-strip__head">
        <b>{copy?.headline}</b>
        <span className="assessment-dispute-strip__stamp">
          {disputeKindLabels[dispute.kind]} · {formatStamp(dispute.createdAt)}
        </span>
      </header>

      {/* 理由逐条念出来（§14.2「界面要能念出理由」）。`recheckReason` 为 null 时
          共享层已经说了"复核还没做"，这里不再补一句"维持"。 */}
      <dl className="assessment-dispute-strip__reasons">
        <dt>我当时的理由</dt>
        <dd>{dispute.statement}</dd>
        {dispute.supplement ? (<><dt>补充说明</dt><dd>{dispute.supplement}</dd></>) : null}
        <dt>复核结论</dt>
        <dd>{copy?.detail}</dd>
        {dispute.corrections.map((correction) => (
          <span key={correction.id} className="assessment-dispute-strip__correction">
            <dt>{correctionKindLabels[correction.kind]}</dt>
            <dd>
              {correction.reason}
              <small>{formatStamp(correction.createdAt)}</small>
            </dd>
          </span>
        ))}
      </dl>

      {notice ? <p className="assessment-dispute-strip__notice" role="status">{notice}</p> : null}
      {failure ? <p className="assessment-dispute-strip__failure" role="alert">{failure}</p> : null}

      <div className="assessment-dispute-strip__actions">
        {copy?.acceptsSupplement ? (
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => { setSupplementing(true); setFailure(null); }}
          >
            补充说明
          </button>
        ) : null}
        {canClose ? (
          <>
            <label className="assessment-dispute-strip__hold">
              <input
                type="checkbox"
                checked={holdObjective}
                disabled={busy !== null}
                onChange={(event) => setHoldObjective(event.target.checked)}
              />
              <span>同时把这一项设为「暂不安排」</span>
            </label>
            <button type="button" className="button primary" disabled={busy !== null} onClick={() => void submitClose()}>
              {busy === "close" ? "正在结束…" : holdObjective ? "结束异议并暂不安排" : "结束这份异议"}
            </button>
          </>
        ) : (
          <p className="assessment-dispute-strip__hint">这份异议已经收尾，不需要再按一次。</p>
        )}
      </div>
      {copy?.acceptsSupplement && supplementing ? (
        <div className="assessment-dispute-strip__form">
          <label className="assessment-dispute-strip__label" htmlFor="assessment-dispute-supplement">补充一句</label>
          <textarea id="assessment-dispute-supplement" autoFocus rows={3} maxLength={2000}
            value={supplement} onChange={(event) => setSupplement(event.target.value)}
            placeholder="写下需要补充的条件或说明。" disabled={busy !== null} />
          <p className="assessment-dispute-strip__hint">补充会保存到这份异议，已经保存的复核结论不会重开。</p>
          <div className="assessment-dispute-strip__actions">
            <button type="button" className="button primary" disabled={busy !== null} onClick={() => void submitSupplement(supplement)}>
              {busy === "supplement" ? "正在记下…" : "记下补充说明"}
            </button>
            <button type="button" className="button" disabled={busy !== null} onClick={() => { setSupplementing(false); setFailure(null); }}>先不补充</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
