/**
 * 今日复习那一行的三个动作（39d W7-4 刀十；39 §12 表「今日复习」行）。
 *
 * 那张表对这一行写的是：「一批有限任务，**展示选择原因**」／可做「**可换顺序、减量、
 * 延后、暂停**」／**剩余需求不伪称完成**。
 *
 * ## 最后那半句是这一刀的全部
 *
 * 三个动作里任何一个做完之后，**没做完的那几道仍然是没做完**。而这件事在屏上极易
 * 写成"今天完成 3 道"——因为那三道确实做完了，而剩下的没被任何一句文案提到。读数
 * 于是变成"今天做了 3 道"，而她手上有 5 道到期需求。
 *
 * 所以这一份**每个动作都交回 `remaining`**，而且**三档都不许把它写成 0**——除非
 * 候选真的空了。屏上要念的是"今天做了 3 道，另有 2 道还在"，不是"今天完成"。
 *
 * ## 「减量」与「加量」是同一件事的两端
 *
 * §9.4「批次一旦开始，**不因后台新任务到期不断增加长度**；**用户主动加量**才加入新的
 * 任务」。减量同样**只能由她发起**——后台把批次缩短会让"今天先到这里"这句话随一批
 * 任务的到期而反复变，说出口就作废。所以两个方向共用一把"用户改长度"的闸（0305），
 * 只是符号相反。
 *
 * ## 「暂停」停的是**这一批**，不是那些目标
 *
 * 目标级的「暂不安排」是另一件事（W7-3 的 `review_hold`），它改的是那颗目标。
 * 停一批是停"今天这一批"——批次结束、剩余需求原样留着，明天重新开批。两者混成
 * 一件事的后果：她点一次"暂停"，那 5 颗目标就再也不会回来了，而屏上没有任何一句
 * 说过这件事。
 */

/** 三个动作的档位。`swap`（可换顺序）由判据那一侧排，这一份只管另外三个。 */
export type TodayBatchActionV2 = "reduce" | "pause" | "resume";

export interface TodayBatchOptionInputV2 {
  /**
   * 今天这一批**锁定的长度**（0305 那一行）。减量要改的就是它。
   */
  readonly lockedLength: number;
  /** 减去多少。<= 0 视为 0（不是"加回去"）。 */
  readonly reduceBy?: number;
  /** 今天还剩几道没做。**这是"剩余需求"的唯一读数**——三个动作都原样带出去。 */
  readonly remaining: number;
  readonly paused: boolean;
}

export interface TodayBatchOptionResultV2 {
  readonly action: TodayBatchActionV2;
  /**
   * 改完之后**今天这一批锁定的新长度**。
   *
   * `reduce` ⇒ `max(0, locked - reduceBy)`；`pause` / `resume` ⇒ **不变**。
   * 暂停不改长度是刻意的：长度是"这一批本来有多长"的记录，暂停是"现在不做了"。
   * 把两者合成一个"当前长度"，那么暂停再恢复时那一批会短一截——而她什么也没少做。
   */
  readonly lockedLength: number;
  readonly paused: boolean;
  /** §12 表「剩余需求**不伪称完成**」——三档都原样带出去，**不许**在这里归零。 */
  readonly remaining: number;
  /**
   * 屏上那一行的**读法**。`remaining > 0` 时**必须**带上它——这是这一刀存在的原因。
   */
  readonly screenLine: string;
  /** 延后那一档（§12 表「可…延后」）：把某一道挪到哪一天。null = 这一发不延后任何一道。 */
  readonly deferredObjectiveId?: string | null;
}

export function decideTodayBatchOptionV2(
  input: TodayBatchOptionInputV2,
  action: TodayBatchActionV2,
): TodayBatchOptionResultV2 {
  const remaining = Math.max(0, input.remaining);

  if (action === "pause") {
    return {
      action,
      // 暂停**不改长度**：长度是"这一批本来有多长"的记录，暂停是"现在不做了"。
      lockedLength: input.lockedLength,
      paused: true,
      remaining,
      // 暂停那一行**必须**念出剩余——它是"没有丢掉"的那句话。
      screenLine: remaining > 0
        ? `这一批先停在这里，剩下 ${remaining} 道还在。`
        : "这一批已暂停，目前没有待复习的卡片。",
    };
  }

  if (action === "resume") {
    return {
      action,
      lockedLength: input.lockedLength,
      paused: false,
      remaining,
      screenLine: remaining > 0
        ? `接着做今天这一批，剩下 ${remaining} 道。`
        : "这一批已恢复，目前没有待复习的卡片。",
    };
  }

  // reduce：只减，不许负；也不许因为 reduceBy<=0 就"顺手重算今天该有多少道"——
  // 那是 §9.4 禁止的那一条路（后台改长度）。
  const by = Math.max(0, input.reduceBy ?? 0);
  const lockedLength = Math.max(0, input.lockedLength - by);
  return {
    action: "reduce",
    lockedLength,
    paused: input.paused,
    remaining,
    screenLine: remaining > 0
      ? `今天先做 ${lockedLength} 道，剩下 ${remaining} 道还在。`
      : "已调整今天的安排，目前没有待复习的卡片。",
  };
}
