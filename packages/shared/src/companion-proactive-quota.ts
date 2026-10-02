/**
 * 40 §8「主动表达」的**额度与丢弃**判据。
 *
 * ## 为什么这一份要单独成文件
 *
 * §8 的要求里，最容易被写错、也最难在真机上看出的是**额度怎么算**。原有的
 * `companion-proactive-policy` 答的是"现在能不能打扰"（勿扰、安静时段、冷却、
 * 去重、忽略反馈），它没有答这三件事：
 *
 *  1. **一次持续使用期间最多一条普通招呼/感想**——而"持续使用"不是墙上时钟：
 *     站内切页、反复回首页、切换窗口**都不重置**。
 *  2. **「今天别催学习」按本地日抑制**，但**不取消已授权安排**。
 *  3. **恢复后过时的主动消息直接丢弃**，不形成消息债务。
 *
 * 三条都是纯判据，没有 IO，所以放在这里能穷举着测。而它们各自都对应一个
 * 具体形状的错：把额度绑在时间窗上（于是每半小时又冒一条）、把抑制写成
 * 取消安排（于是用户丢掉了自己约好的事）、把过时消息补发（于是用户回来先读
 * 一堆过期的话）。
 *
 * ## 「一次持续使用」是什么
 *
 * 合同 §8.2 把这一条交给实施设计明确（原文：「离开后何时构成新一次使用沿用既有
 * 节奏规则，**并在实施设计中明确**」）。这里取的口径是：
 *
 * > **一次持续使用 = 一串彼此间隔短于 {@link USAGE_SESSION} 的客户端在场。**
 * > 间隔超过它就算离开，回来是**新一次**使用，额度重新计一次。
 *
 * 选"在场间隔"而不是"当天"或"每次启动"，因为三条都要求跨切页、跨回首页、
 * 跨切窗口**不重置**——而这三件事在客户端看来都是"还在用"。离开的唯一可观测
 * 信号就是一段时间没有在场，所以它是唯一诚实的分界。
 */

/** 一次持续使用的在场间隔上限：超过它就算离开，回来算新一次使用。 */
export const USAGE_SESSION_GAP_MS = 30 * 60_000;

/** 一次持续使用期间，普通招呼/感想的额度（§8.2「最多主动展示一条」）。 */
export const AMBIENT_QUOTA_PER_USAGE = 1;

/**
 * 恢复后超过这个年龄的**普通招呼/过时感想/日记更新气泡**直接丢弃。
 *
 * 为什么是 30 分钟而不是更长：这些消息的**全部价值**是"此刻"。一句"刚才那道题
 * 你卡在哪"隔一小时再说就不成立，而补发它等于让用户回来先读一堆过期的话
 * （§8.2「不形成消息债务」）。约定提醒不在此列——它有自己的时间语义。
 */
export const AMBIENT_STALE_MS = 30 * 60_000;

/**
 * §8.1 的五类主动消息。
 *
 * 这不是 `ProactivePushKind`（routine/triggered）：那个分的是"她想说"与"用户
 * 先要过"，而这里分的是**依据**——不同依据的额度、抑制、丢弃规则都不同，
 * 混在一个两分法里就只能一律处理，于是要么额度管不住，要么提醒被误丢。
 */
export type ProactiveKindV1 =
  /** 用户约定的提醒：领域服务的有效安排与授权。走自己的规则，持久送达。 */
  | "arranged_reminder"
  /** 学习建议：与首页相同的下一步及理由。吃「今天别催学习」的本地日抑制。 */
  | "learning_suggestion"
  /** 相关回顾：当下话题与仍可访问的共同事件有关。 */
  | "related_recall"
  /** 普通招呼或角色感想。吃"一次持续使用最多一条"的额度。 */
  | "ambient"
  /** 日记已更新：实际成稿。默认只在日记入口显示安静提示。 */
  | "diary_updated";

/** 吃"一次持续使用一条"额度的类型。约定提醒按 §8.2「仍按其独立规则持久送达」排除。 */
export const QUOTA_BOUND_KINDS: ReadonlySet<ProactiveKindV1> = new Set<ProactiveKindV1>(["ambient"]);

/** 吃「今天别催学习」本地日抑制的类型。 */
export const LEARNING_NUDGE_KINDS: ReadonlySet<ProactiveKindV1> = new Set<ProactiveKindV1>(["learning_suggestion"]);

export type AmbientQuotaReason =
  | "allowed"
  /** 这一类不吃额度（约定提醒、回顾、日记更新）。 */
  | "kind_not_quota_bound"
  /** 本次持续使用里那一条已经用掉了。 */
  | "quota_exhausted"
  /** 多个候选只选一个，不轮流补播。 */
  | "picked_another_candidate"
  /** 上一条普通招呼被忽略了：不为同一件事换一种说法再问。 */
  | "ignored_no_rewrite";

export interface AmbientQuotaDecision {
  allow: boolean;
  reason: AmbientQuotaReason;
  /** 多个候选时的名次：0 是被选中的那个，其余一律 `picked_another_candidate`。 */
  rank: number;
}

/**
 * 普通招呼/感想的额度判定。
 *
 * @param ambientDeliveredThisUsage 本次持续使用期间**已经展示**的普通招呼数。
 * @param candidatesThisRound 本轮候��的普通招呼条数（>1 时只放第一条）。
 * @param rank 本条在候选里的名次（0 起）。
 * @param lastAmbientIgnored 上一条普通招呼是否被用户忽略。
 */
export function evaluateAmbientQuota(input: {
  kind: ProactiveKindV1;
  ambientDeliveredThisUsage: number;
  candidatesThisRound: number;
  rank: number;
  lastAmbientIgnored: boolean;
}): AmbientQuotaDecision {
  if (!QUOTA_BOUND_KINDS.has(input.kind)) {
    return { allow: true, reason: "kind_not_quota_bound", rank: input.rank };
  }
  // 「用户忽略消息，不换一种说法再问」：被忽略过就不再用这一类去打扰。
  // 这一条排在额度之前——因为额度耗尽时本来也不会再问，两者的可观察后果相同，
  // 但忽略之后**下一段**使用里额度会重置，只有这一条能让"被忽略"延续过去。
  if (input.lastAmbientIgnored) return { allow: false, reason: "ignored_no_rewrite", rank: input.rank };
  if (input.rank > 0) return { allow: false, reason: "picked_another_candidate", rank: input.rank };
  if (input.ambientDeliveredThisUsage >= AMBIENT_QUOTA_PER_USAGE) {
    return { allow: false, reason: "quota_exhausted", rank: input.rank };
  }
  return { allow: true, reason: "allowed", rank: input.rank };
}

/**
 * 「今天别催学习」。
 *
 * @param suppressedLocalDate 用户说过"今天别催"的那一**本地日**（YYYY-MM-DD）；
 *   null = 从没说过，或说的是别的日子。
 * @param todayLocalDate 此刻的本地日。
 */
export function learningNudgeSuppressed(input: {
  suppressedLocalDate: string | null;
  todayLocalDate: string;
}): boolean {
  return input.suppressedLocalDate !== null && input.suppressedLocalDate === input.todayLocalDate;
}

/**
 * 学习建议的抑制判定。**只压"主动推荐"，不碰已授权安排**。
 *
 * §8.2 原文：「用户说『今天别催学习』，该本地日不再主动推荐学习；
 * **不会取消已授权安排**。仍有用户约定提醒时以低打扰方式说明该区别，
 * 用户明确取消才修改安排。」
 */
export function evaluateLearningSuggestion(input: {
  kind: ProactiveKindV1;
  suppressedLocalDate: string | null;
  todayLocalDate: string;
}): { allow: boolean; reason: "allowed" | "kind_not_learning" | "suppressed_today" } {
  if (!LEARNING_NUDGE_KINDS.has(input.kind)) {
    return { allow: true, reason: "kind_not_learning" };
  }
  if (learningNudgeSuppressed(input)) return { allow: false, reason: "suppressed_today" };
  return { allow: true, reason: "allowed" };
}

export type StaleReason = "kept" | "stale_ambient" | "stale_kind_keeps_value";

/**
 * 恢复后的丢弃判定。
 *
 * §8.2：「从专注或离线状态恢复后，约定提醒先核对有效性并合并展示；**普通招呼、
 * 过时感想和日记更新气泡直接丢弃**，不形成消息债务。」
 *
 * `diary_updated` 也在丢弃之列——它默认只在日记入口显示一个安静提示，
 * 而那本入口**用户回来就会自己看到**。为它攒一条气泡，等于把"已经在那儿的东西"
 * 再通知一遍。
 */
export function evaluateStaleAfterResume(input: {
  kind: ProactiveKindV1;
  ageMs: number;
  /** 约定提醒还要不要先核对有效性（§8.2「约定提醒先核对有效性并合并展示」）。 */
  arrangementStillValid: boolean;
}): { keep: boolean; reason: StaleReason } {
  if (input.kind === "arranged_reminder") {
    return { keep: true, reason: "stale_kind_keeps_value" };
  }
  if (input.ageMs >= AMBIENT_STALE_MS) return { keep: false, reason: "stale_ambient" };
  return { keep: true, reason: "kept" };
}

/**
 * 在场是否续上当前这次持续使用。
 *
 * §8.2：「站内切页、反复回首页、切换窗口**不重置**该额度。」客户端在这三件事
 * 里的在场间隔都远小于 {@link USAGE_SESSION_GAP_MS}，所以"间隔够短就续上"
 * 天然满足这三条；而"当天"或"每次启动"那种口径会把它们误判成新一次使用。
 */
export function continuesUsageSession(input: { msSincePresence: number | null }): boolean {
  return input.msSincePresence !== null && input.msSincePresence < USAGE_SESSION_GAP_MS;
}

/**
 * 用户**本地日**的今天（YYYY-MM-DD）。
 *
 * 为什么不能用 `new Date().toISOString().slice(0, 10)`：那是 UTC。用户在 UTC+8
 * 的凌晨 0:30 说话，UTC 那边还是前一天——于是"今天别催学习"会写进**昨天**，
 * 而比较时"今天"也取成昨天，两者相等，看起来没问题；但只要用户时区是 UTC-5，
 * 傍晚说的那句话就会被记到**明天**上，结果是明天一整天都被压住。
 *
 * `timeZone` 拿不到时退回 UTC：这时算错一天的代价是"少催一次"，比"多催"轻。
 */
export function localDateIn(timeZone: string | null | undefined, now: Date): string {
  if (!timeZone) return now.toISOString().slice(0, 10);
  // 用格式器而不是位移算术：位移算法要自己处理夏令时，格式器交给运行时。
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  try {
    return formatter.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * 账号上的「今天别催学习」此刻是否生效。
 *
 * `pause` 直接取 `user_companion_account_state.suggestion_pause`。
 *
 * ⚠️ 这里**只压"主动推荐学习"**。约定提醒（用户自己约的安排）走它自己的规则
 * ——§8.2：「不会取消已授权安排。仍有用户约定提醒时以低打扰方式说明该区别，
 * 用户明确取消才修改安排。」把它一起压掉，就是让用户丢掉自己约好的事。
 */
export function evaluateLearningNudgePause(input: {
  pause: { paused?: boolean; localDate?: string; timezone?: string } | null | undefined;
  now: Date;
}): { suppressed: boolean; suppressedLocalDate: string | null; todayLocalDate: string } {
  const todayLocalDate = localDateIn(input.pause?.timezone, input.now);
  const suppressedLocalDate = input.pause?.paused && input.pause.localDate
    ? input.pause.localDate
    : null;
  // 只认**今天**。昨天说的"今天别催"不该压到今天；明天也不该被今天的这句话压住。
  return {
    suppressed: learningNudgeSuppressed({ suppressedLocalDate, todayLocalDate }),
    suppressedLocalDate,
    todayLocalDate,
  };
}
