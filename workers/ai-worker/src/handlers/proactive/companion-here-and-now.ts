/**
 * 环境快照（方案 29 §4.1）：每轮**无条件**注入的「她现在知道什么」。
 *
 * 为什么是注入而不是工具：基线实测 90.7% 的轮次她一个工具都没拿到（`selectSkill`
 * 关键词没命中 → 工具面为空 → 单步）。把「知道当前时间/在学什么/刚写了什么笔记」
 * 做成一次工具调用，等于把这些事实也一并关进了那 90.7%。所以：
 *
 *   **自觉 = 每轮免费预计算；工具 = 需要下钻时才调。**
 *
 * 全部走 SQL，不调模型，跑在对话 handler 已有的那个 RLS 读事务里（`loadHereAndNow`
 * 收 `tx` 而不是自己开事务，就是为了不多一次往返、也不脱离 RLS 作用域）。
 *
 * 时区口径：库里存 UTC，用户侧是 +8。时区**不硬编码**——取
 * `user_companion_account_state.quiet_hours->>'timezone'`（客户端 `Intl` 探测后随
 * 静默时段一起存进来的，见 proactive-hook 的同一来源），缺省才回落 Asia/Shanghai。
 * 主动提醒的静默判定用的就是这一列，两处必须同源，否则会出现「她说现在是早上，
 * 但静默时段按另一个钟判」的分裂。
 */

import { sql } from "drizzle-orm";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import type { WorkerTransaction } from "../../db.ts";
import { normalizeWorkspaceAIPolicy, visionReaderAvailableFromConfig } from "../../lib/governance.ts";
import { parsePageContext } from "../turn/companion-dialogue-content.ts";
import { readLivePageView, type LivePageView } from "../turn/companion-live-view.ts";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";

const FALLBACK_TIMEZONE = "Asia/Shanghai";

/**
 * 可见笔记数——**唯一一句话**（环境块的 `noteCount` 与 `readLearningStats` 的
 * `note_count` 共用）。
 *
 * 只判 `workspace_id` + `deleted_at` 会把协作空间里别人**私有**的笔记算进去，
 * 而首页那一格是"我看得见的笔记有几篇"。这条分岔是 W2-3 的对账测试抓到的，
 * 两处从此共用一个算式。
 */
export function visibleCompanionNoteCountSql(scope: { workspaceId: string; userId: string }) {
  return sql`(SELECT count(*) FROM notes n
    WHERE n.workspace_id = ${scope.workspaceId} AND n.deleted_at IS NULL
      AND ${sql.raw(noteVisibleSqlText("n", `'${scope.userId}'::uuid`))})`;
}

export interface HereAndNowSnapshot {
  /** Database transaction clock and the same effective timezone as localTime. */
  observedAt?: string;
  timezone?: string;
  /** 用户本地钟面时间，如 `2026-09-20 18:12`。 */
  localTime: string;
  /** 中文星期，如 `周六`。 */
  weekday: string;
  /** 中文时段：凌晨/早上/上午/中午/下午/傍晚/晚上/深夜。 */
  partOfDay: string;
  /** 距上一次伴星对话多少分钟；从未聊过为 null。 */
  minutesSinceLastSeen: number | null;
  pet: { name: string; activeness: string; interactionCount: number } | null;
  today: { studySeconds: number; runs: number };
  noteCount: number;
  pendingProposals: number;
  /**
   * 用户此刻停在哪个界面（抱怨 #5「看不到我当前界面」）。
   *
   * 这是**本轮免费预计算**而不是工具：她要么知道用户在哪儿，要么这一轮根本不知道
   * 该问什么。title 只有在实体级页面（笔记/卡片）才解析得出来，其余只有页面类型。
   */
  currentPage: { kind: string; title: string | null; statusLine: string | null } | null;
  /**
   * 上面那一行的**原始实时行**（bridge 的 pageKind 原值 + items）。
   *
   * `currentPage` 是给人看的中文标签形态，这一份是给判据用的：实体先行解析要拿
   * `items[].ordinal` 落"第 N 张"这种指称。两处共用同一次读（`readLivePageView`），
   * 所以不会出现"她说你在这一屏、却认不出这一屏的第 3 项"这种分叉。
   */
  livePageView: LivePageView | null;
  /**
   * 最近一条还没兑现的提醒（她答应过的事）。不放进快照，她就只能"当场记住"，
   * 转头又问用户"你要我提醒什么"——许过约却不记得，比从没答应更伤信任。
   */
  nextReminder: { text: string; fireAtLocal: string } | null;
  /** 图片现在能不能看（政策开着 **且** 有可用的看图模型——与工具下发面同源）。 */
  imagesReadable: boolean;
  /** 看不了时的原因（措辞用）：政策没开 / 没有可用的看图模型；能看时为 null。 */
  imagesUnreadableReason: "policy_off" | "no_reader" | null;

}

/** 学习统计的一份真值。取数与摘要都只有这一处，工具与环境块共用。 */
export interface LearningStatsFacts {
  readonly todayMinutes: number;
  readonly weekMinutes: number;
  readonly activeCards: number;
  readonly noteCount: number;
}

/** 工具返回给模型的 safeSummary 与环境块那一行共用同一句措辞（两处各写迟早会分叉）。 */
export function summarizeLearningStats(facts: LearningStatsFacts): string {
  return `今日 ${facts.todayMinutes} 分钟，本周 ${facts.weekMinutes} 分钟，学习卡 ${facts.activeCards} 张`;
}

interface LearningStatsRow extends Record<string, unknown> {
  today_seconds: string;
  week_seconds: string;
  active_cards: string;
  note_count: string;
}

/**
 * 学习统计的唯一取数（`companion_get_learning_stats` 与环境块共用）。
 *
 * 以前这段 SQL 只长在工具那侧，环境块想要同一份数就得再抄一遍——而"两处各写一份
 * 同一个口径"正是这一串修复一直在拆的东西（日额度写过四份、静默时段写过两份）。
 * 周口径是**滚动 7 天**，不是自然周：改了这里，工具答话和环境块会一起变，
 * 这也正是共用一份的意义。
 */
export async function readLearningStats(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<LearningStatsFacts> {
  const rows = await tx.execute<LearningStatsRow>(sql`
    SELECT
      (SELECT coalesce(sum(active_seconds_used), 0) FROM learning_metric_events
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND occurred_at >= date_trunc('day', now() AT TIME ZONE ${tzSubquery(scope.userId)}) AT TIME ZONE ${tzSubquery(scope.userId)}
      ) AS today_seconds,
      (SELECT coalesce(sum(active_seconds_used), 0) FROM learning_metric_events
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND occurred_at > now() - interval '7 days'
      ) AS week_seconds,
      (SELECT count(*) FROM note_learning_cards c
        JOIN notes card_note ON card_note.id = c.note_id
        WHERE c.workspace_id = ${scope.workspaceId} AND c.status = 'active'
          AND card_note.deleted_at IS NULL
          AND ${sql.raw(noteVisibleSqlText("card_note", `'${scope.userId}'::uuid`))}
      ) AS active_cards,
      ${visibleCompanionNoteCountSql(scope)} AS note_count
  `);
  const row = (Array.isArray(rows) ? rows : [])[0] ?? null;
  return {
    todayMinutes: Math.round(Number(row?.today_seconds ?? 0) / 60),
    weekMinutes: Math.round(Number(row?.week_seconds ?? 0) / 60),
    activeCards: Number(row?.active_cards ?? 0),
    noteCount: Number(row?.note_count ?? 0),
  };
}

function partOfDay(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

/** 下标 = Postgres `EXTRACT(DOW)`：0=周日…6=周六。 */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * Postgres `EXTRACT(DOW)`（0=周日…6=周六）→ 中文星期。
 *
 * 这里**不**用 `EXTRACT(isodow)`：`dow`/`hour` 都是 Postgres 的保留字（type_name /
 * func_name 类），裸当列别名用会 "syntax error at or near"，把整条快照查询打挂。
 * 别名改用 weekday/hour_of_day，字段名也就跟着换成了同样写法大写的 DOW/HOUR。
 */
export function weekdayLabel(dow: number): string {
  return WEEKDAYS[Number(dow)];
}

/**
 * 「3 小时前」「昨天」「3 天前」这种相对说法；模型转述比 ISO 时间戳自然得多。
 * 导出给工具执行器用（搜索/读取笔记的"上次改动"），两处说法必须一致——
 * 同一个时间在她嘴里出现两种讲法，比不自然更像 bug。
 */
export function ageLabel(minutes: number): string {
  if (minutes < 2) return "刚刚";
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  const days = Math.round(minutes / (24 * 60));
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

/**
 * 用户这句话点名的那篇笔记（《标题》形态，取第一个）。
 *
 * 为什么"有没有这篇"要在读阶段就算出来（方案 29 §9.29，实机五轮）：主模型面对
 * "《X》写了什么"会**不查而答**，并且给出可证伪的假阴性——"都搜过了，库里没有这篇"
 * （而那篇在库里，3 个正文块）。同一句 prompt 指名道姓要求它调用
 * `companion_search_notes` 仍然不动；被 steer 换到兜底模型之后才真的去调。
 * 也就是说"要不要查"不能交给它决定：这里先把结果当数据给它，
 * 她只需要负责读和说。
 */
export async function loadHereAndNow(
  tx: WorkerTransaction,
  scope: {
    workspaceId: string;
    userId: string;
    conversationId?: string | null;
    /**
     * 本轮正在回的那一条 user 消息的 seq。给了它，「距上次说话」就只排除**这一句**，
     * 其余（包括同一会话里几分钟前的那一轮）照算——不然她会看见一块写着「14 小时前」
     * 的当下状态，而同一份 prompt 的时间线写着上一条是 3 分钟前。
     */
    currentRequestSeq?: string | null;
    /** 本轮 Bridge page context（对象或 JSON 字符串）；缺省就没有"当前界面"这一行。 */
    pageContext?: unknown;
  },
): Promise<HereAndNowSnapshot> {
  // 时钟与账号：单条 SELECT 常量查询，永远返回一行（账号行缺失时走回落时区）。
  // 别名不能叫 `hour`/`date`——它们是 Postgres 保留字，裸用会 "syntax error at or near"
  // （实机把整条 read 阶段打挂，job 连败三次）。
  const clock = (await tx.execute<{ local_time: string; weekday: number; hour_of_day: number; observed_at: string; timezone: string }>(sql`
    SELECT
      to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') observed_at,
      ${tzSubquery(scope.userId)} timezone,
      to_char(now() AT TIME ZONE ${tzSubquery(scope.userId)}, 'YYYY-MM-DD HH24:MI') local_time,
      EXTRACT(DOW FROM now() AT TIME ZONE ${tzSubquery(scope.userId)})::int weekday,
      EXTRACT(HOUR FROM now() AT TIME ZONE ${tzSubquery(scope.userId)})::int hour_of_day
  `))[0];

  // 缺省取**系统默认人格**，不再写死 '伴星' / 'moderate'：她开口时的身份来自默认人格，
  // 环境快照却报另一个名字与另一档话量，用户会当场看出"这地方说的是谁"。
  const defaultPersona = getDefaultPersonaPreset();
  const petRows = await tx.execute<{
    name: string; activeness: string; interaction_count: number; last_active_at: Date | null;
    boundaries: Record<string, unknown> | null;
  }>(sql`
    SELECT coalesce(a.profile->>'name', ${defaultPersona.name}) AS name,
           coalesce(a.profile->>'activeness', ${defaultPersona.activeness}) AS activeness,
           coalesce(r.interaction_count, 0) AS interaction_count,
           r.last_active_at,
           a.profile->'boundaries' AS boundaries
    FROM (SELECT ${scope.userId}::uuid AS user_id) u
    LEFT JOIN companion_persona_profiles a ON a.user_id = u.user_id
    LEFT JOIN pet_profiles r
      ON r.workspace_id = ${scope.workspaceId} AND r.user_id = u.user_id
  `);
  const petRow = petRows[0];

  // conversationId 为空 = 跨**本空间所有**会话取最近一次说话（主动交流机会需要整体对话间隔）。
  // 给了本轮 seq（对话路径）就只排除**她正在回的这一句**：那才是"0 分钟前"的自指来源。
  // 以前的写法是把整个当前会话排除掉，于是她一边在同一个会话里几分钟前刚说过话，
  // 一边读到「距上次和用户说话：14 小时前」——同一份 prompt 里跟回放时间线直接打架。
  // workspace_id 必须在：多空间审查实测到，缺它时 A 空间的发言会改掉 B 空间她说的
  // "你已经 3 天没理我了"——同一句话在两个空间里指向两个事实。
  const excludeCurrentTurn = scope.conversationId && scope.currentRequestSeq
    ? sql`AND NOT (conversation_id = ${scope.conversationId} AND seq >= ${scope.currentRequestSeq}::bigint)`
    : scope.conversationId
      ? sql`AND conversation_id <> ${scope.conversationId}`
      : sql``;
  const seenRows = await tx.execute<{ gap: number | null }>(sql`
    SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) / 60 gap
    FROM companion_messages
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId} ${excludeCurrentTurn}
  `);
  const gapMinutes = seenRows[0]?.gap == null ? null : Math.round(Number(seenRows[0].gap));

  // 今日学习量：按**用户本地日**切，不按 UTC 日——否则早上看到的"今日"是昨天下午。
  const todayRows = await tx.execute<{ seconds: string; runs: string }>(sql`
    SELECT coalesce(sum(active_seconds_used), 0) seconds, count(DISTINCT run_id) runs
    FROM learning_metric_events
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND occurred_at >= date_trunc('day', now() AT TIME ZONE ${tzSubquery(scope.userId)}) AT TIME ZONE ${tzSubquery(scope.userId)}
  `);

  // 三处笔记查询都带**归属边界**（@astella/shared/note-visibility，与 HTTP 侧同一
  // 句话）。只按 workspace 数/取标题时，协作空间里她会在甲的对话里念出乙的私有笔记
  // 标题，并把这些标题注进 prompt 外发模型——审查原文把它记成"中"，但它和
  // `companion_read_note` 是同一类越界：空间隔离挡不住同空间的别人。
  const noteCountRows = await tx.execute<{ n: string }>(sql`
    SELECT ${visibleCompanionNoteCountSql(scope)} n
  `);
  const proposalRows = await tx.execute<{ n: string }>(sql`
    SELECT count(*) n FROM companion_action_proposals
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND status = 'pending'
  `);

  const reminderRows = await tx.execute<{ text: string; fire_at_local: string }>(sql`
    SELECT text,
           to_char(fire_at AT TIME ZONE ${tzSubquery(scope.userId)}, 'MM-DD HH24:MI') AS fire_at_local
    FROM companion_reminders
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'pending'
    ORDER BY fire_at
    LIMIT 1
  `);

  // 图片外发政策在这里也要读一份：注入进去的那句"这篇有 6 张图，看不了"必须与
  // **工具下发面**同源，否则会出现"告诉她看不了、却又把读图工具给她"或反过来。
  // 同源指同一个判定函数（`normalizeWorkspaceAIPolicy`）跑在同一张表的同一行上——
  // 读法不同（这里在既有读事务里一条 SELECT，那边从治理上下文取），口径相同。
  // 2026-10-06 起还要与识图路由同源：政策开着但**没有可用的看图模型**时，
  // 读图工具同样不下发（见 resolveVisionReader），措辞必须跟着分开。
  const policyRows = await tx.execute<{ data_policy: unknown }>(sql`
    SELECT data_policy FROM user_ai_settings WHERE user_id = ${scope.userId} LIMIT 1
  `);
  const imagePolicyEnabled = normalizeWorkspaceAIPolicy(
    // 没有这一行=没同意过，`normalizeWorkspaceAIPolicy` 自己会回落到 fail-closed 默认。
    policyRows[0]?.data_policy as Parameters<typeof normalizeWorkspaceAIPolicy>[0],
  ).sendImageContent === true;
  const imagesReaderAvailable = visionReaderAvailableFromConfig();
  const imagesReadable = imagePolicyEnabled && imagesReaderAvailable;
  const imagesUnreadableReason: HereAndNowSnapshot["imagesUnreadableReason"] = imagesReadable
    ? null
    : (imagePolicyEnabled ? "no_reader" : "policy_off");

  // 当前页只读宿主实时行，作为环境事实提供给模型。
  const livePageView = await readLivePageView(tx, scope);

  return {
    observedAt: clock?.observed_at,
    timezone: clock?.timezone,
    localTime: clock?.local_time ?? "",
    weekday: weekdayLabel(clock?.weekday ?? 1),
    partOfDay: partOfDay(Number(clock?.hour_of_day ?? 12)),
    minutesSinceLastSeen: gapMinutes,
    pet: petRow
      ? { name: petRow.name, activeness: petRow.activeness, interactionCount: Number(petRow.interaction_count) }
      : null,
    today: {
      studySeconds: Number(todayRows[0]?.seconds ?? 0),
      runs: Number(todayRows[0]?.runs ?? 0),
    },
    noteCount: Number(noteCountRows[0]?.n ?? 0),
    pendingProposals: Number(proposalRows[0]?.n ?? 0),
    imagesReadable,
    imagesUnreadableReason,
    nextReminder: reminderRows[0]
      ? { text: reminderRows[0].text, fireAtLocal: reminderRows[0].fire_at_local }
      : null,
    currentPage: await resolveCurrentPage(tx, scope, livePageView),
    livePageView,
  };
}

/** 页面类型的中文说法；`other`/`home` 不渲染（见 resolveCurrentPage）。 */
/**
 * 首块正文 → 注进环境快照的那一句"开头是…"。
 *
 * 只取到第一句，并把换行压成空格：这一段的作用是**让她不必自己补原文**
 * （实机 2026-09-22 AC 轮她零工具交出一段课本话当"原文"），不是替她读完全篇——
 * 给得越多，越像可以照抄，而它不进历史、也不带块结构。
 */
export function noteOpeningExcerpt(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  const stop = flat.search(/[。！？!?；;]/);
  const firstSentence = stop >= 0 ? flat.slice(0, stop + 1) : flat;
  // 不再按 120 字剪：句子到哪算完由标点定，剪在半句上会让她照着半句说话，
  // 而那正是这一格要避免的"她以为原文就这么短"。
  return firstSentence.length > 0 ? firstSentence : null;
}

export const PAGE_KIND_LABELS: Record<string, string> = {
  note: "笔记",
  source: "资料",
  star_map: "理解星图",
  settings: "设置中心",
  conversation: "伴星中心",
};

/**
 * 本轮她面对的是哪个界面（抱怨 #5「看不到我当前界面」）。
 *
 * `pageKind` 为 `other`/`home`（实测占多数——人 idle 在首页）时返回 null：
 * 注入"用户正在看：首页"对模型是纯噪音，她只会围绕"你在首页"找话。
 * 实体级页面才查标题——只说"用户在笔记页"帮不了她，说得出是哪篇才算知道。
 */
async function resolveCurrentPage(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string; pageContext?: unknown },
  livePageView: LivePageView | null,
): Promise<{ kind: string; title: string | null; statusLine: string | null } | null> {
  // ── 实时那条优先（39b §9.6：「只留实时那条」）─────────────────────────────
  // `assistant_page_contexts` 是渲染层逐屏发布的**实时行**（带 `readable_view`），
  // 而 `scope.pageContext` 是 `run.page_context` 那个**审计字段**（`sanitizeContext`
  // 收窄后的副本）。同一个"我在哪一屏"过去只从审计字段取，所以她读不到那一屏上正在
  // 发生什么；更早的版本则是同一份"我在哪"算了两遍（宽的那份只有调工具才读）。
  //
  // 顺序刻意是"实时优先、审计兜底"而不是"只留实时"：P4-b/P4-c 那 11 页还没登记
  // `readable_view`（W2-7），此刻把审计那条删掉会让这些页从"知道在哪一屏"退化成
  // "什么都不知道"——违反 39b §11「中途任何一批停下，系统行为不会比今天差」。
  // 等 16 页全登记完，兜底那一支才谈得上删。
  //
  // `home`/`other` 有意跳过：人 idle 在首页，注入"用户正在看：首页"对模型是纯噪音。
  if (livePageView && livePageView.pageKind !== "other" && livePageView.pageKind !== "home") {
    return {
      kind: PAGE_KIND_LABELS[livePageView.pageKind] ?? livePageView.pageKind,
      title: livePageView.title,
      statusLine: livePageView.statusLine,
    };
  }

  const context = parsePageContext(scope.pageContext);
  const pageKind = typeof context?.pageKind === "string" ? context.pageKind : null;
  if (!pageKind || pageKind === "other" || pageKind === "home") return null;
  const refs = Array.isArray(context?.entityRefs)
    ? (context.entityRefs as unknown[]).filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    : [];
  const label = PAGE_KIND_LABELS[pageKind] ?? pageKind;
  const noteRef = refs.find((entry) => typeof entry.noteId === "string");
  const cardRef = refs.find((entry) => typeof entry.cardId === "string");
  if (noteRef) {
    const rows = await tx.execute<{ title: string }>(sql`
      SELECT title FROM notes
      WHERE id = ${String(noteRef.noteId)}::uuid
        AND workspace_id = ${scope.workspaceId}
        AND deleted_at IS NULL
        AND ${sql.raw(noteVisibleSqlText("notes", `'${scope.userId}'::uuid`))}
      LIMIT 1
    `);
    return { kind: label, title: rows[0]?.title ?? null, statusLine: null };
  }
  if (cardRef) {
    const rows = await tx.execute<{ stem: string | null }>(sql`
      SELECT q.stem FROM note_learning_card_questions q
      JOIN note_learning_cards c ON c.id = q.card_id
      WHERE c.id = ${String(cardRef.cardId)}
        AND c.workspace_id = ${scope.workspaceId}
      ORDER BY q.ordinal
      LIMIT 1
    `);
    return { kind: label, title: rows[0]?.stem ?? null, statusLine: null };
  }
  return { kind: label, title: null, statusLine: null };
}


/**
 * 账号级时区的标量子查询；quiet_hours 缺字段时回落。
 *
 * 导出给提醒兑现/挂钟换算用（companion-agent-runtime）：她说"现在几点"、静默时段
 * 判定、"明早九点"换 UTC 必须是同一个钟，各写一处迟早会分裂成差八小时。
 */
export function tzSubquery(userId: string) {
  return sql`coalesce(
    (SELECT quiet_hours->>'timezone' FROM user_companion_account_state
      WHERE user_id = ${userId} LIMIT 1),
    ${FALLBACK_TIMEZONE})`;
}

/**
 * 渲染成注入 system prompt 的数据块。
 *
 * 只写**有值的行**：空行（"当前学习：无"）对模型是负价值——它会开始围绕"没有"
 * 编话题。整块控制在几十字符内，这段每轮都发，长度直接乘在每一次调用上。
 */
export function renderHereAndNow(snapshot: HereAndNowSnapshot): string | null {
  const lines: string[] = [];
  lines.push(`现在：${snapshot.localTime} ${snapshot.weekday}（${snapshot.partOfDay}）`);

  if (snapshot.minutesSinceLastSeen != null && snapshot.minutesSinceLastSeen >= 20) {
    lines.push(`距上次和用户说话：${ageLabel(snapshot.minutesSinceLastSeen)}`);
  }
  if (snapshot.pet) {
    lines.push(`你是「${snapshot.pet.name}」`);
  }
  // 今日学了多久 / 跑了几个运行 / 笔记库共几篇**不再渲染**（实机 2026-09-21：用户只说
  // 了「嘿嘿」，她回"今天已经学了 42 分钟，本周累计 99 分钟"）。这块是她的感知，
  // 不是台词本；用户真问"我今天学了多久"时她走 companion_get_learning_stats，
  // 那条路实测通（同一口径）。
  //
  // An inventory of recent notes made greetings repeat yesterday's work.
  // The current page and explicit note reference remain below; library history
  // is available through the existing read tools when the user asks about it.
  if (snapshot.pendingProposals > 0) {
    lines.push(`还有 ${snapshot.pendingProposals} 个动作在等用户确认`);
  }
  if (snapshot.currentPage) {
    const page = snapshot.currentPage;
    lines.push(`用户正在看${page.kind}${page.title ? `《${page.title}》` : ""}`);
    // 那一屏的**状态行**（来自该页自己发布的 `readable_view.statusLine`，逐字）。
    // 有它她才能回答"这一页怎么了"，而没有它只能说"你在笔记页"——后者帮不上忙。
    if (page.statusLine) lines.push(`这一屏：${page.statusLine}`);
  }
  if (snapshot.nextReminder) {
    lines.push(`你已经答应：${snapshot.nextReminder.fireAtLocal} 提醒用户「${snapshot.nextReminder.text}」`);
  }

  if (lines.length <= 1) return null;
  return ["<here_and_now>", ...lines, "</here_and_now>"].join("\n");
}
