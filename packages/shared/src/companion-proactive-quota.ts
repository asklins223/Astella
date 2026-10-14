/** Agent 主动交流的学习建议抑制与恢复后过时交付判据。 */

/** 恢复后，超过这个年龄的普通主动交付直接丢弃。 */
export const AMBIENT_STALE_MS = 30 * 60_000;

/** 主动交付依据，供学习建议抑制与恢复后过时判定使用。 */
export type ProactiveKindV1 =
  | "arranged_reminder"
  | "learning_suggestion"
  | "related_recall"
  | "ambient"
  | "diary_updated";

/** 吃「今天别催学习」本地日抑制的类型。 */
export const LEARNING_NUDGE_KINDS: ReadonlySet<ProactiveKindV1> = new Set(["learning_suggestion"]);

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
