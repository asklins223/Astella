/**
 * 流中工具调用槽的**累积与"是否已经完整"**判定。
 *
 * ## 为什么要把这段从 provider 里搬出来
 *
 * 这段逻辑原来写在 `openai-compatible.ts` 的 SSE 循环里：每次来一片
 * `delta.tool_calls`，按 `index` 归并 `id` / `name` / `arguments` 文本。
 * 它决定了两件事——**参数什么时候拼得完**、**一个调用什么时候可以放心交出去**。
 *
 * 而它住在网络循环里，是本仓**最难测**的一类代码：没有合成 SSE 的喂入夹具，
 * 改坏了要等到真 provider 接入才暴露。把它变成纯函数之后：
 *
 *  - "分片乱序 / 重复 / 空片 / 只有名字没有参数"这些形状可以穷举着测；
 *  - 40b §4.1-1 的「**不能从流式 JSON 片段、猜测调用名**」这条禁令，
 *    从"循环里的一句 if"变成**一条可断言的函数**。
 *
 * ## 它不做的事
 *
 * 不判断"能不能执行"——那是 `companion-eager-dispatch.ts` 的事（顺序、缺口、
 * 确认门、白名单）。这里只回答一个更窄的问题：**这些分片拼起来，够不够完整**。
 * 两层分开是因为前者可以在不碰 provider 的情况下先测完。
 */

export interface StreamToolCallSlot {
  index: number;
  id: string;
  name: string;
  /** 逐片拼接的 arguments 文本，**可能**是半截 JSON。 */
  argsText: string;
}

type Slot = StreamToolCallSlot;

/**
 * 一路流里累积的那些槽。
 *
 * 用**类**而不是裸对象，是为了把"index 缺号"这件事也收进来：协议可能先吐
 * index 2 再补 index 1，而 `companion-eager-dispatch.ts` 正是靠缺口判定
 * 决定"能不能越过"。缺号必须在累积层就被如实记下，不能被补成连续数组。
 */
export class StreamToolCallAccumulator {
  private readonly slots = new Map<number, Slot>();
  /** provider 还没给出 index 时用的下一个槽位。 */
  private nextImplicitIndex = 0;
  /** 已经放行过的 index —— 同一格不许被派发两次。 */
  private readonly reported = new Set<number>();

  /** 收一片 `delta.tool_calls`；返回这一次**新变得可判定完整**的那些 index。 */
  push(fragments: readonly StreamToolCallFragment[]): number[] {
    const becameSettled: number[] = [];
    for (const fragment of fragments) {
      const index = typeof fragment.index === "number" && fragment.index >= 0
        ? fragment.index
        : this.nextImplicitIndex;
      if (index >= this.nextImplicitIndex) this.nextImplicitIndex = index + 1;

      // ⚠️ 必须先算出**改动前**的判定值。原地改同一个对象的话，
      // 改完之后再去问"它之前落定过吗"拿到的已经是改完的答案，
      // 于是"这一片让参数补齐了"这件事永远报不出来。
      const wasSettled = this.isSettled(this.slots.get(index) ?? { index, id: "", name: "", argsText: "" });

      const existing = this.slots.get(index);
      const slot: Slot = existing ?? { index, id: "", name: "", argsText: "" };
      // id / name 只在**第一次**非空时落地：后续分片重复带同一个 id 是常态，
      // 无条件覆盖会把已确认的身份换成后到的那一份。
      if (!slot.id && typeof fragment.id === "string" && fragment.id.length > 0) {
        slot.id = fragment.id;
      }
      // name 与 arguments 相反：**追加**。分词器可能把一个名字切成多片。
      if (typeof fragment.name === "string") slot.name += fragment.name;
      if (typeof fragment.arguments === "string") slot.argsText += fragment.arguments;

      this.slots.set(index, slot);
      if (!wasSettled && this.isSettled(slot)) becameSettled.push(index);
    }
    return becameSettled;
  }

  /**
   * 一个槽"参数已经拼完"。
   *
   * 判据是**arguments 能解析成一个对象**——不是"结尾有个 `}`"，也不是"长度够了"。
   * 半截 JSON 也可能恰好以 `}` 结尾（`{"a":1}` 的第一片就可能是它），而那不是完整参数。
   *
   * 调用名也必须已经拿到：40b §4.1-1「不能猜测调用名」。
   */
  private isSettled(slot: Slot): boolean {
    if (!slot.name) return false;
    const text = slot.argsText.trim();
    if (text.length === 0) return false;
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }

  /**
   * 流结束时的最后一次释放：此时"不会再有分片"才真正成立，
   * 所以**所有**已落定、还没放行过的槽都该放行。
   *
   * 没有这一步，最后一个调用永远排不上——而它恰恰是模型最常只调一个工具的那种情况。
   */
  flush(): number[] {
    const released: number[] = [];
    for (const index of [...this.slots.keys()].sort((a, b) => a - b)) {
      if (!this.reported.has(index) && this.isSettled(this.slots.get(index)!)) {
        this.reported.add(index);
        released.push(index);
      }
    }
    return released;
  }

  /**
   * 当前可**安全**放行的 index（已落定、且后面已经有更高的 index 出现过）。
   *
   * 只给 `settled` 不够：一片就拼完的那个槽，**后面还可能有分片**。
   * 协议不提供"第 N 个调用已完成"事件，所以唯一的可靠依据是顺序：
   * 第 N+1 个开始吐 ⇒ 第 N 不会再有分片。
   */
  readyForDispatch(maxIndex: number): number[] {
    const ready: number[] = [];
    for (const index of [...this.slots.keys()].sort((a, b) => a - b)) {
      if (index >= maxIndex || this.reported.has(index)) continue;
      if (this.isSettled(this.slots.get(index)!)) {
        this.reported.add(index);
        ready.push(index);
      }
    }
    return ready;
  }

  /** 全部槽（含还没拼完的），按 index 升序。 */
  snapshot(): StreamToolCallSlot[] {
    return [...this.slots.values()]
      .sort((a, b) => a.index - b.index)
      .map((slot) => ({ ...slot }));
  }

  /** 缺口：0..max 里没收到的那些 index。 */
  gaps(): number[] {
    if (this.slots.size === 0) return [];
    const max = Math.max(...this.slots.keys());
    const out: number[] = [];
    for (let i = 0; i <= max; i += 1) if (!this.slots.has(i)) out.push(i);
    return out;
  }
}

export interface StreamToolCallFragment {
  index?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}