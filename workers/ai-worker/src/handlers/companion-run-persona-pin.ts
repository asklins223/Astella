/**
 * 一个 run 绑定哪一版人格（40 §4.8.4 / 40b §5.3.2 / A50）——纯判据，不查库。
 *
 * 从 `companion-dialogue.ts` 搬出来是因为它自己就够一条域：这一轮**是谁在说话**。
 * handler 那边仍然负责把它交给谁、固定后写回 run（`companion-run-persona-pin.test.ts`
 * 里那条源码判据盯的就是"决策必须交给这个函数，不许在装配段内联"）。
 *
 * ## 两条硬规则
 *
 * 1. **一次调用使用固定版本。** 已经固定过的 run 只认它自己那个号，正文从那条
 *    **不可变版本行**读；只有首次固定才读账号当前档案，随后把号写回 run，
 *    之后每一轮都走"已固定"分支。于是同一个 run 的第 1 轮与第 40 轮拿到的是
 *    同一份人格，不会因为中途改设置而分属两版。
 *
 * 2. **排队的（待生效）那一版对当前 run 不生效。** 账号人格现在有「当前 / 待生效」
 *    两版（`companion_persona_profiles.pending_revision`）。待生效存在的意义是
 *    "让用户看得见还没生效的那一版"，不是"让某个 run 提前用上它"——合同把它的生效
 *    时点写成"下一次会话建立时"，而这里的判断发生在 run **已经建立之后**。
 *    所以这个函数只认 `currentRevision`，并对 `stagedRevision` 做一次硬断言：
 *    万一将来有人把待生效也当成候选传进来，当场抛错，而不是让用户在一次
 *    已经进行中的对话里被悄悄换掉人格。
 */

export interface RunPersonaPin {
  /** 本次调用绑定的人格版本号。 */
  revision: number;
  examplesRevision: number;
  defaultExpressionVersion: string;
  /** 绑定的那一版的正文（来自不可变版本行，或首次固定时的账号当前档案）。 */
  content: unknown;
  /** true = 这一次是首次固定（随后要把三个身份字段写回 run）。 */
  fresh: boolean;
}

export function resolveRunPersonaPin(input: {
  /** run 上已固定的号；null = 这一次还没固定过。 */
  pinnedRevision: number | null;
  pinnedExamplesRevision: number | null;
  pinnedDefaultExpressionVersion: string | null;
  /** 账号当前生效的版本号与正文（只有首次固定时才用得上）。 */
  currentRevision: number | null;
  currentContent: unknown;
  /** 账号排队的待生效版本号（明确不参与本次绑定）。 */
  stagedRevision: number | null;
  /** 已固定那一版的不可变版本行正文。 */
  pinnedContent: unknown;
  currentDefaultExpressionVersion: string;
}): RunPersonaPin {
  const fresh = input.pinnedRevision === null;
  const revision = fresh
    ? Number(input.currentRevision ?? 0)
    : Number(input.pinnedRevision);
  if (input.stagedRevision !== null && revision === input.stagedRevision) {
    throw new Error(
      "companion run must not bind the pending persona revision before it is activated",
    );
  }
  const examplesRevision = fresh
    ? revision
    : Number(input.pinnedExamplesRevision ?? input.pinnedRevision);
  return {
    revision,
    examplesRevision,
    defaultExpressionVersion: fresh
      ? input.currentDefaultExpressionVersion
      : (input.pinnedDefaultExpressionVersion ?? input.currentDefaultExpressionVersion),
    // 首次固定读当前档案；已固定读那一版的不可变版本行（revision 0 = 无覆盖）。
    content: fresh ? (input.currentContent ?? null) : (input.pinnedContent ?? null),
    fresh,
  };
}
