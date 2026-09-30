/**
 * 轮次状态转移的**唯一一份纯判据**（39d W4-5 第二刀；形状取自 `companion-journey/journey-reducer.ts`）。
 *
 * 为什么单独一个文件而不是写在 service 里：D1 §5.1 那张转移表是产品语义
 * （三值 phase、四值 outcome、终态只读），而"能进哪个状态"这件事不该等到真库才知道——
 * 单测能钉，且钉得住。DB 那侧由 0282 的双向 CHECK 兜住同一件事
 * （`closed` 必带 `outcome` 与 `closed_at`），两份判据必须同向，改一边要同时改另一边。
 *
 * 三条不许松的口（都来自 D1，不是本文件的偏好）：
 *  - **`closed` 之后任何动作都是拒绝**（§3.3「`closed` 之后不可恢复」；「继续学习」
 *    只恢复 `active`/`paused`，§3.2）。昨天收尾的轮次可以作为下一轮起点，但不重开原轮。
 *  - **重复的 pause／resume 是不推进计数器的 noop**，不是第二次转移。§6.3 那个
 *    `revision` 是"状态与计划修订共用"的 CAS 计数器，多端来回切窗口如果每次
 *    重复请求都 +1，"改了点什么"与"什么都没变"就分不出来了。
 *  - `close` 必须带 outcome（§3.3 那张表把"终态原因"与"结果"分开记，但落库时同一次）。
 */

export type RoundPhaseV1 = "active" | "paused" | "closed";

export type RoundOutcomeV1 = "completed" | "partial" | "superseded" | "system_failure";

export type RoundStateV1 = {
  phase: RoundPhaseV1;
  outcome: RoundOutcomeV1 | null;
  pausedAt: Date | null;
  resumedAt: Date | null;
  closedAt: Date | null;
};

export type RoundActionV1 =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "close"; outcome: RoundOutcomeV1 };

/** 拒绝的理由码（service 侧原样映射成 `RoundServiceError` 的 code）。 */
export type RoundRejectionV1 =
  | "round_closed"
  | "invalid_transition"
  | "outcome_required";

export class RoundTransitionError extends Error {
  constructor(readonly reason: RoundRejectionV1, message: string) {
    super(message);
    this.name = "RoundTransitionError";
  }
}

export type RoundTransitionResultV1 = {
  state: RoundStateV1;
  /** false = 这次请求什么都没改（调用方**不许**推进 revision）。 */
  changed: boolean;
};

/** D1 §3.3：轮次只有三个 phase，刻度刻意粗；这里把"粗"写成判据而不是注释。 */
export function applyRoundAction(
  state: RoundStateV1,
  action: RoundActionV1,
  now: Date = new Date(),
): RoundTransitionResultV1 {
  if (state.phase === "closed") {
    // 终态只读：迟到判定作为带时间的补充回执挂回原轮的子记录（§16.19），
    // 不是"把轮次打开再改一次"。
    throw new RoundTransitionError(
      "round_closed",
      "这一轮已经收尾，终态只读：不重开、不改写当时结算",
    );
  }
  switch (action.kind) {
    case "pause":
      if (state.phase === "paused") return { state, changed: false };
      return {
        state: { ...state, phase: "paused", pausedAt: now, resumedAt: state.resumedAt },
        changed: true,
      };
    case "resume":
      if (state.phase === "active") return { state, changed: false };
      return {
        state: { ...state, phase: "active", resumedAt: now },
        changed: true,
      };
    case "close": {
      if (!action.outcome) {
        // 类型上不允许为空，这里仍然判一次：调用方如果是 `as never` 塞进来的假值，
        // 那正是"库里出现没有原因的终态"的来路，不该由 DB CHECK 兜着当意外。
        throw new RoundTransitionError("outcome_required", "收尾必须写明结果");
      }
      return {
        state: {
          ...state,
          phase: "closed",
          outcome: action.outcome,
          closedAt: now,
        },
        changed: true,
      };
    }
    default: {
      const seen = (action as { kind?: string }).kind;
      throw new RoundTransitionError("invalid_transition", `不认识的轮次动作：${String(seen)}`);
    }
  }
}

/** 「继续学习」只恢复未终结轮次（D1 §3.2）：可恢复 = 这两个档。 */
export function isRoundRecoverable(phase: RoundPhaseV1): boolean {
  return phase === "active" || phase === "paused";
}
