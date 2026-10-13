/**
 * 思考窗口的收与露（2026-10-13）。
 *
 * 服务端按块下发思考（攒够 800 字或 350ms 才落一次库），客户端如果**收到就画**，
 * 界面就是一跳一跳的——用户实测反馈"一卡一卡的"。这里把"收"和"露"分开：
 *
 * - **收**：按序号续接。重放过的同一块不重复贴；中间缺了一块就不猜——那一段根本没
 *   送到，接着拼会拼出一句她没想过的话，所以从未收到的这块重新起头。
 * - **露**：每次心跳从积压里搬一小步到显示区（一步最多六分之一，最少 2 字），
 *   所以一块 300 字会在两三拍里铺完，而不是一次糊上来。
 *
 * 显示区只保留尾部若干字：一轮思考可以有几万字，屏幕要的是"此刻在想"，
 * 不是把整条思考流堆进气泡里等人往上翻。积压与显示区分开存，裁掉的老字永远不会
 * 把正在露的那一行裁空。
 */

/** 显示区长度：气泡里最多留这么多字的思考尾。 */
export const COMPANION_THINKING_TAIL_CHARS = 1_600;
/**
 * 每步搬积压的这么多分之一（2026-10-13 用户明确：平滑**不许**拖慢上游）。
 *
 * 这是按比例追，不是固定字数：上游多快，这里就多快搬，稳态落后 ≈ 一拍 × 这个除数
 * （50ms × 4 = 200ms 的思考流），所以上游飙到 5,000 字/秒时也只是"显示的是
 * 0.2 秒前想的那句"，不会越落越远。真要立刻见底，把除数改小即可，代价是又变回跳。
 */
const CATCH_UP_DIVISOR = 4;
/** 积压很少时，每步也至少搬这么多字。 */
const MIN_STEP_CHARS = 2;

export interface CompanionThinkingView {
  readonly runId: string;
  /** 正在露出的思考尾部。 */
  readonly shown: string;
  /** 已收到、还没露出的部分。 */
  readonly pending: string;
  /** 下一块期望的序号。 */
  readonly nextIndex: number;
}

const EMPTY = (runId: string): CompanionThinkingView =>
  ({ runId, shown: "", pending: "", nextIndex: 0 });

/** 收一块思考（不画，画交给 `revealCompanionThinking` 的心跳）。 */
export function appendCompanionThinking(
  current: CompanionThinkingView | null,
  runId: string,
  index: number,
  text: string,
): CompanionThinkingView {
  // 换一轮（含重连后从 0 重新计数）就清空：上一轮想过的字不留在这一轮的屏上。
  const base = current === null || current.runId !== runId ? EMPTY(runId) : current;
  if (index < base.nextIndex || text.length === 0) return base;
  const continued = index === base.nextIndex;
  const merged = continued ? base.pending + text : text;
  // 积压永不超过一屏：多出来的那部分本来就永远滚不进窗口（显示区只留尾部
  // COMPANION_THINKING_TAIL_CHARS 字），留着它只会把"正在露"越拖越后面。
  // 上游飙起来时宁可跳过看不见的中段，也不让显示落后于她此刻在想的东西。
  const capped = merged.length > COMPANION_THINKING_TAIL_CHARS
    ? merged.slice(merged.length - COMPANION_THINKING_TAIL_CHARS)
    : merged;
  return {
    runId,
    // 缺块：接不上就从不收到的这一块重新起头。正在露的那一段也一起丢掉——
    // 留着它再拼新块，屏幕上就成了一句她没连续想过的话。
    shown: continued ? base.shown : "",
    pending: capped,
    nextIndex: index + 1,
  };
}

/** 心跳：把积压往前搬一小步。没有积压时原样返回（不产生新的渲染）。 */
export function revealCompanionThinking(view: CompanionThinkingView): CompanionThinkingView {
  if (view.pending.length === 0) return view;
  const step = Math.max(MIN_STEP_CHARS, Math.ceil(view.pending.length / CATCH_UP_DIVISOR));
  const moved = view.pending.slice(0, step);
  const joined = view.shown + moved;
  return {
    ...view,
    shown: joined.length > COMPANION_THINKING_TAIL_CHARS
      ? joined.slice(joined.length - COMPANION_THINKING_TAIL_CHARS)
      : joined,
    pending: view.pending.slice(step),
  };
}

/** 界面要显示的那一段。 */
export function companionThinkingText(view: CompanionThinkingView | null): string {
  return view?.shown ?? "";
}

/** 还有没有没露完的思考（决定心跳要不要继续跑）。 */
export function companionThinkingPending(view: CompanionThinkingView | null): boolean {
  return view !== null && view.pending.length > 0;
}
