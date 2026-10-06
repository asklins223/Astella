/**
 * `LearningRunBody` 的那一整套**纯函数、文案表与类型**。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * 原文件 1-709 行是 39 个模块级纯函数/常量/类型，710-2478 才是 `LearningRunBody`。
 * 逐个查引用后发现：**除 4 个类型外，全部只被 `LearningRunBody` 用**。
 *
 * 于是它们其实不是「这个页面的东西」，而是「那个组件的东西」——只是因为组件和它们
 * 写在同一个文件里，模块私有作用域让它们**看起来**是文件级的。
 *
 * 这与 2026-09-29 拆 `notebook-surface.tsx` 那一轮撞上的是同一堵墙：
 * **切不动从来不是依赖多，是形状没有可引用的名字。** 模块私有的声明对外面等于没有名字。
 *
 * ## 搬的时候注意
 *
 * - `LearningRunBodyProps` **留在原文件**：它是页面的 prop 表，由 `LearningRunSurface` 组装。
 * - 那四个类型（`LearningRunResultV2` / `LearningRunOutcome` / `ScheduleImpact` /
 *   `ResultState` 等）跟着走，因为纯函数要用它们；页面那边改为 import。
 * - 所有 JSX **逐字未改**。`learning-run-surface.result.test.tsx` 那 37 条盯着它。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
export type ResultState =
  | { kind: "idle" }
  | { kind: "pending"; phase: Extract<GetLearningRunResultResponseV2, { status: "pending" }>["phase"] }
  | { kind: "result"; value: Extract<GetLearningRunResultResponseV2, { status: "learning_result" }> }
  | { kind: "terminal"; value: Extract<GetLearningRunResultResponseV2, { status: "terminal_without_result" }> };

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Lightbulb, Pause, Play, RotateCcw } from "lucide-react";
import { ArtifactPayload, LearningDraftPayload, LearningRendererDraftState, LearningTaskPublic, StructuredPartAnswerV1, StructuredPartPublicV1 } from "@ailearn/shared/learning-run-contracts";
import { GetLearningRunResultResponseV2, LearningRunAllowedActionV2, LearningRunPublicSnapshotV2, LearningRunTargetRevealV2 } from "@ailearn/shared/learning-run-v2-contracts";
import { DesktopLearningRunActionRequestV2, DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, RendererGatewayError, unwrapGatewayResult } from "../../../app/desktop-client";
import { formatObjectiveDay } from "./objective-state-copy.ts";
import { learningRunFeedback } from "./objective-quest-presentation.ts";

export type TargetRevealState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; reveal: LearningRunTargetRevealV2 }
  | { kind: "unavailable"; message: string };

export type PlayerFailure = {
  readonly message: string;
  readonly retryable: boolean;
};

export type PlayerRecovery = "draft" | "submit" | "action";

export type LearningRunResultV2 = Extract<GetLearningRunResultResponseV2, { status: "learning_result" }>["result"];
export type LearningRunOutcome = LearningRunResultV2["outcome"];
export type ScheduleImpact = LearningRunResultV2["scheduleImpact"];

export function needsLearningRunResync(error: unknown): boolean {
  return error instanceof RendererGatewayError
    && (error.retry === "resync_first" || error.code === "conflict" || error.code === "result_unknown");
}

/** 一次作答的绝对上限：到点自动结束，不再挂着不计分也不结算（复盘 #13）。 */
export const FOCUS_SESSION_LIMIT_SECONDS = 60 * 60;

/**
 * 阶段的用户可见文案。导出给"未完成的学习"那一页共用：同一条 run 在两个面上
 * 必须用同一个词（审计 F24）。
 */
export const phaseLabels: Record<LearningRunPublicSnapshotV2["phase"], string> = {
  
  preparing: "正在准备任务",
  active: "进行中",
  assessing: "回答已锁定，正在评估",
  checkpoint: "等待下一步",
  committing: "正在记录可信结果",
  paused: "已暂停",
  completed: "已完成",
  ended: "已结束",
  skipped: "已跳过",
  cancelled: "已取消",
  stale: "内容已变化",
  recoverable_error: "可以恢复",
};

/**
 * 投影里的 `phase` 是 `string`（不是枚举），所以这里给一个查表 + 兜底：
 * 认不出的阶段原样显示，别让清单吞掉一个它没见过的值。
 */
export function learningPhaseLabel(phase: string): string {
  return (phaseLabels as Record<string, string>)[phase] ?? phase;
}

export const terminalCopy: Record<Extract<ResultState, { kind: "terminal" }>["value"]["reasonCode"], string> = {
  user_ended: "这次旅程已安全结束，没有生成新的学习结果。",
  runtime_cancelled: "这次旅程被取消，没有生成新的学习结果。",
  target_fingerprint_changed: "学习卡已经更新，本次旅程不能继续写入旧结果。",
  schedule_generation_changed: "复习安排已经变化，本次旅程不能继续消费旧安排。",
  permission_revoked: "当前账号已失去这条学习内容的权限。",
};

// 静态穷举表既防止新增 outcome 时漏掉结果印章，也为异常展示模型保留安全文案。
// 正常路径优先采用 learningRunFeedback 给出的、能随真实证据变化的 seal。
export const outcomeSeal: Record<LearningRunOutcome, string> = {
  demonstrated: "掌握完成",
  partial: "推进一段",
  needs_repair: "发现缺口",
  not_assessable: "暂未判定",
  practice_completed: "练习已留痕",
  skipped: "已放回路线",
  declared_unable: "先去补给",
};

export const facetLabels: Record<string, string> = {
  recall: "回忆",
  paraphrase: "复述",
  explain: "解释",
  example: "举例",
  apply: "应用",
  boundary: "边界",
  procedure: "步骤",
  relate: "关联",
  repair: "修补",
};

export const verdictLabels: Record<string, string> = {
  covered: "说清了",
  partial: "只说清了一部分",
  missing: "没说到",
  contradicted: "说反了",
  not_assessable: "无法判定",
};

/**
 * 跳过与「暂时不会」不配印章（DESIGN.md:152「跳过或声明暂时不会时不显示印章，
 * 不做庆祝」）。此前这两个 outcome 照样吃一颗 42px 大印章，和「已理解」同字号
 * 同位置同颜色——用户分不清自己到底做成了什么。
 */
export const SEALLESS_OUTCOMES: ReadonlySet<LearningRunOutcome> = new Set(["skipped", "declared_unable"]);

/**
 * 这次真说清了些什么——只从逐条判定里数，不看 demonstratedFacets。后者是理解
 * 账本（练习永远为空），拿它当「这次做得怎么样」就是把答对了显示成零
 * （31 号文档 P1 的 UI 那一半）。
 *
 * 两个数分开是有意的：**条数**数判定行（四步全说清就是 4 条，那是这次的成品），
 * **facet 名**去重（四行都是「回忆」时不许写成「回忆、回忆、回忆、回忆」）。
 */
export function thisTimeVerdicts(result: LearningRunResultV2 | undefined): {
  readonly coveredCount: number;
  readonly coveredFacets: string[];
} {
  const covered = (result?.assessment?.rubricResults ?? []).filter((item) => item.verdict === "covered");
  return {
    coveredCount: covered.length,
    coveredFacets: [...new Set(covered.map((item) => item.facet))],
  };
}

/**
 * 「算进理解」那一行要说清**为什么是空**，而不是留给用户一句「还没有形成可公开的
 * 已证明部分」——那行字和上面四条「回忆 · 说清了」并排时，读起来就是产品在自己
 * 打自己脸（31 号文档 P1/P6）。练习本就不写理解账本，这是合同，直接讲出来。
 */
/**
 * 处理中阶段的标题（"正在记录可信学习结果" / "回答已锁定，正在评估" / phaseLabels）。
 *
 * 提成模块级是为了**只有一份算式**：它既被工作台那行 `<h2>` 用（`:2781` 那个三元），
 * 也被可读视图用——而可读视图的 `useMemo` 必须落在组件里那个 `if (!snapshot)` 提前
 * return **之前**（Hooks 顺序恒定），所以它不能直接引用那行 `<h2>` 旁边的 `processingHeadline`。
 * 两处各写一份迟早分叉，而分叉不报错。
 */
export function processingHeadlineFor(phase: LearningRunPublicSnapshotV2["phase"]): string {
  return phase === "committing"
    ? "正在记录可信学习结果"
    : phase === "assessing"
      ? "回答已锁定，正在评估"
      : phaseLabels[phase];
}

export function provenLedgerText(result: LearningRunResultV2): string {
  if (result.demonstratedFacets.length) return facetText(result.demonstratedFacets, "");
  if (result.outcome === "practice_completed") return "这次是练习，所以不写进理解账本。";
  return "这次没有能写进理解账本的新证据。";
}

export function stableLineIndex(seed: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  return Math.abs(hash) % length;
}

/**
 * 伴星只念评分已经证明的内容。开头有一点稳定随机感，同一结果反复打开不会换台词，
 * 也不会把模板随机成新的学习结论。
 */
export function companionResultLine(result: LearningRunResultV2, targetSummary: string, seed: string): string {
  const feedback = learningRunFeedback(result);
  const subject = targetSummary.length > 30 ? `${targetSummary.slice(0, 30)}…` : targetSummary;
  const strongestEvidence = feedback.strengths[0] ?? feedback.achievement;
  const nextEvidence = feedback.improvements[0] ?? feedback.gap;
  if (result.outcome === "demonstrated") {
    const opener = ["过关啦", "这关拿下啦", "新的理解证据收好啦"][stableLineIndex(`${seed}:success`, 3)];
    return `${opener}！关于${subject}，${strongestEvidence}`;
  }
  if (result.outcome === "practice_completed") {
    const opener = ["练习记录收好啦", "这一轮走完啦", "这次有了复盘材料"][stableLineIndex(`${seed}:practice`, 3)];
    return `${opener}。${strongestEvidence} 接下来留意：${nextEvidence}`;
  }
  const opener = ["已经向前走了一段", "这次的线索很清楚", "进展已经留下来了"][stableLineIndex(`${seed}:progress`, 3)];
  return `${opener}。${strongestEvidence} 下一步先补：${nextEvidence}`;
}

/**
 * 导出是为了让 `learning-run-surface.schedule-copy.test.ts` 能**直接断言这张表**，
 * 而不是 `readFileSync` 源码抠字面量——那条路一旦 `learning-run-surface.tsx` 被拆分就红，
 * 于是下一个 agent 会以为「测试不能动」，把拆分也一并推迟（2026-09-29 正是如此）。
 */
export const scheduleReasonLabels: Record<string, string> = {
  not_authorized: "当前证据等级不足以改变复习安排",
  // 兜底那句（拿不到逐条判定时才用）：以前写"本次只产生了 facet 级证据"——
  // `facet` 是内部词，用户读不出"差了多少、差哪几处"（审计 F50）。
  facet_only: "这次只补齐了一部分要点",
  record_only: "本次只写入记录",
  practice_only: "本次属于练习，不改变复习",
  diagnostic_only: "本次属于诊断，不改变复习",
  sandbox: "本次在沙盒范围，不改变复习",
  not_assessable: "本次回答无法评估",
  note_evidence_changed: "笔记依据有变化，这次没有推进复习；先回笔记核对原文。",
  // 39 §9.1 行 2：本人对这个目标说了「暂不安排」。这一直缺，于是走到下面那个
  // `?? impact.reasonCode` 的兜底，把内部词 `objective_held` 直接念给用户听了。
  objective_held: "你给这个目标设了「暂不安排」，这次没有推进复习。",
  // 39 §14.2（39d W5-5）：这个目标上有一份还没结论的争议。与上一条要说不同的话——
  // 那一条是「我说了以后别排」，这一条是「上次判定我还在申诉，先别把它的结论推得更远」。
  assessment_disputed: "上次的判定你提了异议，复核之前这次不推进复习；也可以现在结束争议、把这一项暂不安排。",
  skipped: "本次已跳过",
  ended: "旅程提前结束",
  stale: "内容已变化",
};

export function interactionRef(taskId: string, part = "main"): string {
  return `desktop-player-${taskId}-${part}`;
}

/**
 * 本地秒表（2026-09-20 实走复盘 #13）。
 *
 * 服务端 `activeSecondsUsed` 靠 15 秒一次的 activity lease 才更新（失焦时完全不记），
 * 界面前只显示它，于是钟每 15 秒跳一格、看起来像卡死。这里改成本地逐秒推进：
 * 服务端读数只在**更大时**校准本地值（绝不倒退），失焦/隐藏时与租约同规则停走，
 * 两者不会互相甩开。到 60 分钟仍未结束就交给 `onTimeout` 自动收尾。
 */
export function useLocalActiveClock(active: boolean, serverSeconds: number, onTimeout: () => void) {
  const [seconds, setSeconds] = useState(serverSeconds);
  const [ticking, setTicking] = useState(true);

  useEffect(() => {
    setSeconds((current) => (serverSeconds > current ? serverSeconds : current));
  }, [serverSeconds]);

  useEffect(() => {
    const readVisibility = () => document.visibilityState === "visible" && document.hasFocus();
    setTicking(readVisibility());
    const sync = () => setTicking(readVisibility());
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => {
    if (!active || !ticking) return;
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active, ticking]);

  useEffect(() => {
    if (active && ticking && seconds >= FOCUS_SESSION_LIMIT_SECONDS) onTimeout();
  }, [active, ticking, seconds, onTimeout]);

  return { seconds: Math.max(seconds, serverSeconds), paused: !ticking };
}

/**
 * 等待期间回显的答案正文。
 *
 * 只覆盖有自然语言正文的形态；排序/连线/改错这类结构化答案的载荷是一组 id，
 * 在这里还原不出可读原文——那就宁可不显示，也不拼一个看着像但其实不是的东西。
 */
export function answerPreview(payload: ArtifactPayload): string | null {
  switch (payload.kind) {
    case "text": return payload.text.trim() || null;
    case "voice": return payload.confirmedTranscript.trim() || null;
    case "declared_unable": return "这一题我标记为暂时不会。";
    default: return null;
  }
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function facetText(facets: readonly string[], empty: string): string {
  if (facets.length === 0) return empty;
  return [...new Set(facets.map((facet) => facetLabels[facet] ?? facet))].join("、");
}

export function scheduleImpactText(
  impact: ScheduleImpact,
  rubricResults: ReadonlyArray<{ facet: string; verdict: string }> = [],
): string {
  // 到期时间是**未来**，不能用 formatRelative：它算的是 (now - value)，未来时间
  // 得到负 minutes，`minutes < 1` 直接命中「刚刚」——于是明天和下个月都显示
  // 「下次到期 刚刚。」（31 号文档 P4）。复用列表行那套「今天/明天/N 天后」。
  if (impact.kind === "created") return `已创建复习安排，下次到期 ${formatObjectiveDay(impact.dueAt)}。`;
  if (impact.kind === "rescheduled") return `已重新安排复习，下次到期 ${formatObjectiveDay(impact.dueAt)}。`;
  /**
   * 审计 F50：「排程没动」至少有三种原因，界面上以前压成同一句话。`facet_only`
   * 这一种的数据其实全在手里（逐条判定已经返回），所以直接说清"证明了几处、
   * 还差哪几处、差的那些补上才会推进"——而不是留一句"只产生了 facet 级证据"。
   */
  if (impact.reasonCode === "facet_only" && rubricResults.length > 0) {
    const covered = rubricResults.filter((item) => item.verdict === "covered");
    const gaps = [...new Set(rubricResults
      .filter((item) => ["partial", "missing", "contradicted"].includes(item.verdict))
      .map((item) => facetLabels[item.facet] ?? item.facet))];
    if (gaps.length > 0) {
      return `本次没有改变复习安排：${rubricResults.length} 个要点里证明了 ${covered.length} 个，还差 ${gaps.join("、")}；这几处补齐了才会推进排程。`;
    }
  }
  const reason = scheduleReasonLabels[impact.reasonCode] ?? impact.reasonCode;
  return `本次没有改变复习安排：${reason}${reason.endsWith("。") ? "" : "。"}`;
}

export function returnTargetLabel(target: LearningRunPublicSnapshotV2["returnTargetV2"]): string {
  switch (target.kind) {
    case "review": return "回到复习队列";
    case "card": return "回到这张学习卡";
    case "star_map": return "回到理解星图";
    case "today": return "回到今日学习";
    case "onboarding": return "继续首次设置";
    case "note_round": return "回到这一轮";
  }
}

export function routeForReturnTarget(target: LearningRunPublicSnapshotV2["returnTargetV2"]): DesktopRouteV1 {
  return target.kind === "review" ? { kind: "review.queue" }
    : target.kind === "note_round" ? { kind: "note.detail", noteId: target.noteId }
      : { kind: "room.home" };
}

export function emptyPartAnswer(part: StructuredPartPublicV1): StructuredPartAnswerV1 {
  switch (part.kind) {
    case "ordering":
      return { kind: "ordering", partId: part.partId, orderedTokenIds: [...part.publicTokenIds] };
    case "relation":
      return { kind: "relation", partId: part.partId, edges: [] };
    case "repair":
      return { kind: "repair", partId: part.partId, operations: [] };
  }
}

export function emptyEditor(task: LearningTaskPublic): ArtifactPayload {
  const interaction = task.activeVariant.interaction;
  switch (interaction.kind) {
    case "voice_teachback":
      return { kind: "voice", confirmedTranscript: "", correctionMethod: "none" };
    case "text_response":
      return { kind: "text", text: "" };
    case "ordering":
      return {
        kind: "ordering",
        orderedTokenIds: [...interaction.publicTokenIds],
        interactionRefs: [interactionRef(task.taskId)],
      };
    case "single_choice":
      // 不给默认选项：合同里 selectedOptionId 可省略，省略就是"还没选"。
      return { kind: "choice", interactionRefs: [interactionRef(task.taskId)] };
    case "true_false":
      return { kind: "true_false", interactionRefs: [interactionRef(task.taskId)] };
    case "matching":
      return { kind: "matching", assignments: [], interactionRefs: [interactionRef(task.taskId)] };
    case "relation_canvas":
      return { kind: "relation", edges: [], interactionRefs: [interactionRef(task.taskId)] };
    case "repair":
      return { kind: "repair", operations: [], interactionRefs: [interactionRef(task.taskId)] };
    case "structured_bundle":
      return {
        kind: "structured_bundle",
        partAnswers: interaction.parts.map(emptyPartAnswer) as [StructuredPartAnswerV1] | [StructuredPartAnswerV1, StructuredPartAnswerV1],
        interactionRefs: [interactionRef(task.taskId)],
      };
  }
}

export function editorFromDraft(payload: LearningDraftPayload): ArtifactPayload {
  if (payload.kind === "voice") {
    return { kind: "voice", confirmedTranscript: payload.unconfirmedTranscript, correctionMethod: "none" };
  }
  return payload;
}

export function toDraftPayload(payload: ArtifactPayload): LearningDraftPayload | null {
  if (payload.kind === "declared_unable") return null;
  if (payload.kind === "voice") return { kind: "voice", unconfirmedTranscript: payload.confirmedTranscript };
  return payload;
}

export function rendererStateFor(payload: ArtifactPayload): LearningRendererDraftState {
  if (payload.kind === "voice") return { kind: "voice", asrState: payload.confirmedTranscript ? "ready" : "idle" };
  if (payload.kind === "text") {
    return {
      kind: "text",
      selectionStart: payload.text.length,
      selectionEnd: payload.text.length,
    };
  }
  return { kind: "structured", activePartId: null, focusedElementId: null };
}

export function payloadIsReady(payload: ArtifactPayload, task: LearningTaskPublic | null): boolean {
  switch (payload.kind) {
    case "voice":
      return payload.confirmedTranscript.trim().length > 0;
    case "text":
      return payload.text.trim().length > 0;
    case "ordering":
      return payload.orderedTokenIds.length > 1;
    case "choice":
      return Boolean(payload.selectedOptionId);
    case "true_false":
      return typeof payload.answer === "boolean";
    case "matching":
      // 所有左端都必须连上，左右两端都不能重复占用。
      return task?.activeVariant.interaction.kind === "matching"
        && payload.assignments.length === task.activeVariant.interaction.publicLeftIds.length
        && new Set(payload.assignments.map((pair) => pair.leftId)).size === payload.assignments.length
        && new Set(payload.assignments.map((pair) => pair.rightId)).size === payload.assignments.length;
    case "relation":
      return payload.edges.length > 0;
    case "repair":
      return payload.operations.length > 0;
    case "structured_bundle":
      return payload.partAnswers.every((part) => {
        switch (part.kind) {
          case "ordering": return part.orderedTokenIds.length > 1;
          case "relation": return part.edges.length > 0;
          case "repair": return part.operations.length > 0;
        }
      });
    case "declared_unable":
      return true;
  }
  return false;
}

export function actionRequestFor(action: LearningRunAllowedActionV2): DesktopLearningRunActionRequestV2["action"] {
  switch (action.kind) {
    case "pause":
    case "resume":
    case "skip_run":
    case "finish_current_evidence":
    case "finish_without_commit":
    case "retry_prepare":
    case "retry_commit":
      return { kind: action.kind };
    case "switch_variant":
      // 这一格说的是"谁发起的换题"：学习页这颗按钮按下去，理由就是用户自己按了它。
      // 伴星那条路不经过这里——她的理由从工具参数带过来（39d W2-4 #13）。
      return { kind: action.kind, alternativeId: action.alternativeId, reason: "用户在页面上按了换一题" };
    case "request_hint":
      return { kind: action.kind, level: action.level };
    case "activate_followup":
      return { kind: action.kind, followupId: action.followupId };
    case "retry_assessment":
      return { kind: action.kind, assessmentId: action.assessmentId };
    // §5.5「用户明确选择『停止本次评估』则保存原回答，停止该任务后续尝试」。
    // **这一格此前整个缺着**，而服务端已经会宣告这一档——`actionRequestFor` 的
    // `switch` 不穷尽时 TS 同样不报错，于是那颗按钮（如果画了）按下去发出去的
    // 是一个 `undefined` 的 action。指名要带 `assessmentId`：一次 run 可以先后有多次
    // assessment，剥掉它就分不清收的是哪一次。
    case "cancel_assessment":
      return { kind: action.kind, assessmentId: action.assessmentId };
    case "end":
      return { kind: action.kind, abandonLockedEvidence: action.abandonLockedEvidence };
  }
}


/**
 * 走主进程解析并提交这一次作答的返回路由（`navigation.resolve` → `navigation.go`）。
 *
 * **必须经主进程**，不是"顺便"这么走：正式作答期间 `FormalAssessmentGuard` 由主进程
 * 持有，只有这条带 `learningRunId` 的提交才会放行。绕过它，界面看着回到了笔记，闸却还
 * 在"按住"状态，下一次导航会被挡住——而那个症状出现在**别处**，极难往回找。
 *
 * 解析不出来（被删、被禁、被关的目标）不重放：返回 `null`，由调用方落到它自己的兜底。
 * 调用方必须**先**把 run 树摘掉并让出一帧，再调这里——顺序反了，主进程会在 Player
 * 还挂着的时候就放行。
 */
export async function releaseRunThroughMainV1(input: {
  readonly runId: string;
  readonly route: DesktopRouteV1;
}): Promise<DesktopRouteV1 | null> {
  if (!window.ailearn) return null;
  try {
    const resolveResponse = await window.ailearn.navigation.resolve({
      meta: createRequestMeta(),
      route: input.route,
      learningRunId: input.runId,
    });
    const resolved = unwrapGatewayResult(resolveResponse);
    if (resolved.current.scope !== "workspace") return null;
    const goResponse = await window.ailearn.navigation.go({
      meta: createRequestMeta(resolved.current.workspaceEpoch),
      route: resolved.current.route,
      entryKind: "user",
      learningRunId: input.runId,
    });
    const navigated = unwrapGatewayResult(goResponse);
    if (navigated.current.scope !== "workspace") return null;
    return navigated.current.route;
  } catch {
    return null;
  }
}

/**
 * The real LearningRun state machine behind the practice workbench.
 *
 * Behaviour (fences, snapshot resync, draft autosave, activity lease, submit,
 * result polling and the return contract) stays independent from presentation.
 * The workbench deliberately gives every interaction kind enough room to use
 * its own editor instead of forcing every task into a text-answer mockup.
 *
 * 也被**笔记学习页就地作答**挂载（2026-09-28 用户裁决：不跳页）。挂载方给同一个
 * `onExit`，于是离开这一轮的收尾与闸门释放在两条路里是同一段代码，不会有两套。
 */

/**
 * 备选模态的按钮文案（方案 §3 D5）：此前所有备选都写「换一种方式」，
 * 用户看不出换过去是做题还是说话。kind 由服务端随备选一起下发。
 */
export function switchActionLabel(kind: LearningTaskPublic["availableAlternatives"][number]["interactionKind"] | undefined): string {
  switch (kind) {
    case "single_choice": return "改做选择题";
    case "true_false": return "改做判断题";
    case "matching": return "改做配对题";
    case "ordering": return "改做排序题";
    case "relation_canvas": return "改用关系搭建";
    case "repair": return "改用纠错修补";
    case "structured_bundle": return "改用组合证明";
    case "voice_teachback": return "改用语音讲解";
    case "text_response": return "改用自己的话回答";
    default: return "换一种方式";
  }
}

export function actionLabel(action: LearningRunAllowedActionV2): string {
  switch (action.kind) {
    case "pause": return "暂停";
    case "resume": return "继续旅程";
    case "switch_variant": return "换一种方式";
    case "request_hint": return action.level === 1 ? "给我一点提示" : `查看第 ${action.level} 级提示`;
    case "skip_run": return "稍后再做";
    case "activate_followup": return "继续补充证据";
    case "finish_current_evidence": return "结算当前证据";
    case "finish_without_commit": return "结束但不改变复习";
    case "retry_prepare": return "重新准备";
    case "retry_assessment": return "重新评估";
    case "retry_commit": return "重试记录结果";
    // §5.5 三个独立动作的中间那个。**措辞不写「取消评估」**：那听起来像把这一轮的
    // 作答也收走了，而这颗按钮收的只是**这一次判定**——原回答留着，用户之后仍然可以
    // 「重新评估」。三个动作的分量不一样，字面就不该长得像。
    case "cancel_assessment": return "停止本次评估";
    case "end": return "安全退出";
  }
}

export function actionKey(action: LearningRunAllowedActionV2): string {
  const discriminator = "alternativeId" in action
    ? action.alternativeId
    : "level" in action
      ? String(action.level)
      : "taskId" in action
        ? action.taskId
        : "followupId" in action
          ? action.followupId
          : "assessmentId" in action
            ? action.assessmentId
            : "";
  return `${action.kind}-${discriminator}`;
}

export function interactionLabel(task: LearningTaskPublic): string {
  switch (task.activeVariant.interaction.kind) {
    case "voice_teachback": return "语音讲解";
    case "text_response": return "用自己的话回答";
    case "ordering": return "顺序整理";
    case "single_choice": return "选择题";
    case "true_false": return "判断题";
    case "matching": return "配对题";
    case "relation_canvas": return "关系搭建";
    case "repair": return "纠错修补";
    case "structured_bundle": return "组合证明";
  }
}

export function runOriginLabel(origin: LearningRunPublicSnapshotV2["originV2"]): string {
  switch (origin.kind) {
    case "card": return "学习卡练习";
    case "review": return "到期复习";
    case "star_map": return "理解星图练习";
    case "today": return "今日学习";
    case "onboarding": return "首次练习";
    case "note_round": return "这一轮的练习";
  }
}

export function eligibilityLabel(eligibility: LearningRunPublicSnapshotV2["publishedTargetEligibility"]): string {
  switch (eligibility) {
    case "eligible": return "可形成理解证据";
    case "practice_only": return "本次只作练习";
    case "blocked": return "暂不写入证据";
  }
}

export function actionIcon(action: LearningRunAllowedActionV2) {
  if (action.kind === "pause") return <Pause size={14} aria-hidden="true" />;
  if (action.kind === "resume") return <Play size={14} aria-hidden="true" />;
  if (action.kind === "request_hint") return <Lightbulb size={14} aria-hidden="true" />;
  if (action.kind === "end") return <ArrowLeft size={14} aria-hidden="true" />;
  if (action.kind === "switch_variant") return <RotateCcw size={14} aria-hidden="true" />;
  return null;
}
