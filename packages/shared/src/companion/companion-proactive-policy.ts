/**
 * 主动策略 Policy Engine（文档 16 §10.2 纯函数部分）。
 *
 * 确定性策略批准主动提示；模型只负责在批准后生成表达。账号可用状态与
 * 介入强度是两个独立枚举。本模块只做判定（不读模型输出）。
 *
 * 放在 shared 是因为 API 与 worker 共用账号的主动交流节奏。
 *
 * 2026-09-21 的口径改动：**"一天 N 条"这个控件被删掉**，只留"按偏好定间隔"，
 * 并把推送分成 routine / triggered 两类——触发式（用户先约好的提醒、
 * 他正在等的学习完成）不进任何频率限制。理由见 PROACTIVE_CADENCE_MS 的注释。
 */

export type CompanionAvailabilityV1 = "online" | "dnd" | "offline";
export type CompanionInterventionLevelV1 = "quiet" | "moderate" | "active";

/**
 * 两种主动输出，只有一种是"频率"的对象：
 *
 * - **routine** 她自己想开口（到期复习、连续天数、页面到达）。这类才有
 *   "多久说一次"的问题，节奏由 `intervention_level` 决定。
 * - **triggered** 用户先要过的（0238 的到点提醒）或正在等的（学习运行完成）。
 *   这类**不进任何频率限制**：一条 09:00 的提醒如果被"她今天话说多了"压掉，
 *   用户得到的是"提醒不准"，而不是"她很有分寸"。
 */
export interface ProactivePolicyDecision {
  allow: boolean;
  reasonCode:
    | "allowed"
    | "dnd"
    | "offline"
    | "expired";
}

/**
 * 例行主动的最小间隔——**唯一的映射处**（用户 2026-09-21 的口径：
 * "不要给我限制，按用户偏好设置推送频率即可"）。
 *
 * 这里以前是三个"单日额度"（quiet 1 / moderate 3 / active 6）。额度是错的控件：
 * 它不回答"什么时候说"，只回答"说到几条就闭嘴"，于是三档的体感差别是
 * "一天三条 vs 一天六条"，而不是"话多话少"。更糟的是它**会整天静音**——
 * 实测 2026-09-21 13:20 那三条被从没展示过的僵尸念头占满，她连续 21 小时没出声，
 * 而所有上游健康检查都是绿的（§9.58）。
 *
 * 间隔才是"少而轻 vs 多而密"。2026-10-14 用户判定"第一版还是不太行"之后，这组数字
 * 从 3 小时 / 90 分 / 30 分收到 90 分 / 30 分 / 10 分，同时改了两条口径：
 *
 * 1. **安静结束的那次考虑不再计入间隔**（`companion-initiative.ts` 只按真的说了话的
 *    那几次算）。原来的写法把"闲到几分钟 → 想一想 → 没什么可说"也当成一次主动，
 *    于是她每 90 分钟才有一次机会，而只要有一次选择不说，下一次机会又往后推 90 分钟。
 *    用户的体感就是"她从来不主动"——她确实有机会，机会被自己的沉默吃掉了。
 *    沉默是成本问题，不是打扰问题；成本由"一段安静只开一次门"和每档的安静门槛管。
 * 2. 档位仍然只控制**她自己新起的话题**多久可以说一次，不决定她有没有值得说的话；
 *    招呼、答后接续、真实失败与学习结果照旧不受这条管。
 */
export const PROACTIVE_CADENCE_MS: Readonly<Record<CompanionInterventionLevelV1, number>> =
  Object.freeze({
    quiet: 90 * 60 * 1000,
    moderate: 30 * 60 * 1000,
    active: 10 * 60 * 1000,
  });

/**
 * 「陪着的时候」这一档要安静多久，才算一个合适的开口时机。
 *
 * 这是**时机的门槛**，不是说话的额度：安静档 10 分钟（她给你留足空间），
 * 适中 3 分钟，活跃 90 秒（等于客户端能观察到的最早时刻）。
 * 客户端一律在安静满 90 秒时开始上报，之后按 90 秒一格继续报（见
 * `companion-awareness-idle` 的 tracker）；服务端按账号档位决定哪一格算时机，
 * 所以档位既不改客户端行为，也不需要客户端先知道账号状态。
 *
 * 门槛之下的每一格都是一次**便宜的**核对：观察入库、起一个 prep job，
 * 在起整轮模型之前就被这条判据挡住。这不是"被拒绝的机会"——
 * 同一段安静继续下去，下一格会再核对一次。
 */
export const COMPANION_QUIET_PRESENCE_MIN_MS: Readonly<Record<CompanionInterventionLevelV1, number>> =
  Object.freeze({
    quiet: 10 * 60 * 1000,
    moderate: 3 * 60 * 1000,
    active: 90 * 1000,
  });

export function proactiveCadenceMs(level: CompanionInterventionLevelV1): number {
  return PROACTIVE_CADENCE_MS[level];
}

/**
 * 例行主动的间隔判定，API 与 worker 共用这一条。
 */
export function routineCadenceBlocked(input: {
  interventionLevel: CompanionInterventionLevelV1;
  /** 距上一次例行主动开口的毫秒数；从没开过口为 null。 */
  msSinceLastCue: number | null;
}): boolean {
  return input.msSinceLastCue !== null
    && input.msSinceLastCue < proactiveCadenceMs(input.interventionLevel);
}

/**
 * 触发式推送的判定（学习运行完成、到点提醒……用户先要过或正在等的东西）。
 *
 * 单独开一个入口，避免触发式推送继承例行主动才需要的间隔规则：
 * 它要回答的只有"现在能不能给这个人看"，间隔/作答/静默时段/去重都不属于它。
 * 设备明确不在（dnd/offline）仍然挡——气泡进收件箱，人回来照样看得见。
 */
export function evaluateTriggeredPush(input: {
  availability: CompanionAvailabilityV1;
  expired: boolean;
}): ProactivePolicyDecision {
  if (input.availability === "dnd") return { allow: false, reasonCode: "dnd" };
  if (input.availability === "offline") return { allow: false, reasonCode: "offline" };
  if (input.expired) return { allow: false, reasonCode: "expired" };
  return { allow: true, reasonCode: "allowed" };
}

/**
 * 跨话题的主动地板（2026-10-16 用户决定：全局主动**不用节流太严重**）。
 *
 * 上面的 cadence 只管 routine 三类话题，六类触发式与两条自排期完全不进频率限制；
 * 于是"她刚说完一句，紧接着又开口"在**跨话题**上没有任何约束（例如学习完成模板
 * 紧跟着一条招呼）。这条地板补的正是这一格：任意两次主动开口之间至少隔这么久，
 * 不区分 routine / triggered，也不区分是 API 的模板 nudge 还是 worker 的她自己开口。
 *
 * 为什么是 2 分钟、只有这一档：用户口径是"不用节流太严重"。它比最松的一档 cadence
 * （active 10 分钟）小一个数量级，正常使用永远碰不到；只有"同一两分钟内连着开口"
 * 这种真正打扰的情形会被它挡住。触发式仍然**不继承** routine 的 cadence。
 *
 * 约定提醒（`reminder:`）不在这条地板的读数里：那是用户自己约的事，40 §8.2 说停用
 * 也不会取消已授权安排；提醒由 `astella_fire_due_companion_reminders` 直接入队，
 * 本来就不经过这道判定。
 */
export const COMPANION_GLOBAL_PROACTIVE_FLOOR_MS = 2 * 60 * 1000;

/**
 * 跨话题地板判定，API 与 worker 共用这一条。
 *
 * `msSinceAnyCue` 是距上一次主动开口的毫秒差；从没开口过时为 null（放行）。
 * 读数失败也必须按 null 处理：这条闸只该少挡，不该因为读不到就把她静音。
 */
export function globalProactiveFloorBlocked(input: { msSinceAnyCue: number | null }): boolean {
  return input.msSinceAnyCue !== null && input.msSinceAnyCue < COMPANION_GLOBAL_PROACTIVE_FLOOR_MS;
}

// ─── 静默时段（唯一的实现）────────────────────────────────────────────────
//
// 这里曾有两份拷贝，分别在 API 与 worker。**它们已经分叉了**，而且是往危险的方向：
//   - api 那份的注释写着"时区解析失败时 fail closed 抑制（宁可少打扰）"，代码却是
//     `catch { return false }`——false 意思是"**不在**静默时段"，于是配置一坏就照发；
//     `parseClock` 遇到 `"25:00"` 也返回 null → 同样放行；
//   - worker 那份两个分支都返回 true（抑制）。
// 结果是同一个坏配置在 API 放行、worker 抑制。统一后所有主动交流只读本实现。
//
// 统一后的语义：任何解析不出可信钟面值的情况，一律**按静默处理**（不打扰）。
// 真要收提醒，把静默时段清空即可，那是显式动作。

export interface CompanionQuietHours {
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timezone: string;
}

const QUIET_HOURS_FORMATTER_MAX = 32;
const quietHoursFormatterCache = new Map<string, Intl.DateTimeFormat>();

function quietHoursFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = quietHoursFormatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (quietHoursFormatterCache.size >= QUIET_HOURS_FORMATTER_MAX) {
    quietHoursFormatterCache.delete(quietHoursFormatterCache.keys().next().value as string);
  }
  quietHoursFormatterCache.set(timezone, formatter);
  return formatter;
}

/** "HH:MM" → 分钟；不接受 24:00 之外的越界值（24:00 归一为 00:00）。 */
function parseClockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  if (hour === 24) return minute === 0 ? 0 : null;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

/**
 * 静默时段判定（方案 16 §10.2）：HH:MM（startLocal/endLocal）+ IANA 时区，
 * 按**本地钟面**比较，`start > end` 视为跨午夜环绕，`start === end` 视为全时段静默。
 */
export function isWithinQuietHours(quietHours: CompanionQuietHours, now: Date): boolean {
  try {
    const parts = quietHoursFormatter(quietHours.timezone).formatToParts(now);
    // en-US + hour12:false 在午夜可能给出 "24"；不 %24 会算出 1440 分，跨午夜分支判错。
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "") % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "");
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;
    const current = hour * 60 + minute;
    const start = parseClockMinutes(quietHours.startLocal);
    const end = parseClockMinutes(quietHours.endLocal);
    if (start === null || end === null) return true;
    if (start === end) return true;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
  } catch {
    return true;
  }
}
