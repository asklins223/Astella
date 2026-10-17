/**
 * 40 §7「发现簿」的数据形状与**不变量**。
 *
 * ## 这个簿子是什么
 *
 * §7 原话：「发现簿继续是**本人可访问记录与本人收藏的视图**。」它不是排行榜、
 * 不是成就系统、也不是"她的记忆墙"。它只做两件事：
 *
 *  1. 把用户自己**留下来的**东西收在一处（他说的原话、他保留的 AI 建议、
 *     疑问、反例、日记摘录），每条**标清作者与来源**；
 *  2. 同一份内容在笔记旁与发现簿里**共用一个身份**，所以在一处编辑或取消，
 *     另一处同步。
 *
 * ## 为什么"取消收藏不删原始内容"是一条硬约束
 *
 * 因为收藏是**视图**，不是所有权。用户取消收藏，意思只是"我不再把它放在这页"，
 * 原始回答和日记一个字都不该动——它们是别的功能的产物。做成级联删除的话，
 * 一次误点就永久毁掉一篇日记，而且没有任何地方能恢复。所以本文件把它写成
 * 判据而不是注释。
 *
 * ## 为什么不自动生产"成长里程碑"
 *
 * §7 明令：「不按正确率或事件数量自动生产『成长里程碑』。」自动里程碑会把
 * "她学得不错"变成一个需要被维护的指标，于是用户开始刷它。本文件不给它任何
 * 数据形状，就是让这件事没有落点。
 */
import { z } from "zod";

/**
 * 簿子里能放什么。
 *
 * 五类都要求**标清作者**：`assistant` 那一类尤其重要——用户保留的 AI 建议
 * 若不标作者，在簿子里读起来就像用户自己写的，而 §7 要的是"标清作者和来源"。
 */
export const COMPANION_DISCOVERY_KINDS = [
  /** 用户原话。 */
  "user_utterance",
  /** 用户保留的 AI 整理建议。 */
  "kept_ai_suggestion",
  /** 疑问。 */
  "question",
  /** 反例。 */
  "counter_example",
  /** 日记摘录。 */
  "diary_excerpt",
] as const;
export type CompanionDiscoveryKind = (typeof COMPANION_DISCOVERY_KINDS)[number];

export const companionDiscoveryKindSchema = z.enum(COMPANION_DISCOVERY_KINDS);

/** 内容从哪儿来。**与 kind 分开**：同一条日记摘录可能来自空间 A 或 B。 */
export const COMPANION_DISCOVERY_SOURCES = [
  /** 一次普通对话的 assistant 回复。 */
  "assistant_reply",
  /** 一篇日记（带日期与 local date）。 */
  "diary",
  /** 一条伴星记忆（判断/偏好/目标…）。 */
  "memory",
  /** 一次学习运行的产物。 */
  "learning_run",
] as const;
export type CompanionDiscoverySource = (typeof COMPANION_DISCOVERY_SOURCES)[number];

export const companionDiscoverySourceSchema = z.enum(COMPANION_DISCOVERY_SOURCES);

/** 作者。**只能有两种**——用户本人，或伴星。第三方不进这条簿子。 */
export const companionDiscoveryAuthorSchema = z.enum(["user", "assistant"]);

/**
 * 书房痕迹的可见范围。
 *
 * §7：「私人内容**默认**不跨空间、跨成员展示」。所以默认必须是 `private`，
 * 而且 `study`（书房）也只能露出用户**明确放出**的那几条。
 */
export const COMPANION_DISCOVERY_VISIBILITY = ["private", "space", "study"] as const;
export type CompanionDiscoveryVisibility = (typeof COMPANION_DISCOVERY_VISIBILITY)[number];

export const companionDiscoveryVisibilitySchema = z.enum(COMPANION_DISCOVERY_VISIBILITY);

export interface CompanionDiscoveryEntryV1 {
  entryId: string;
  kind: CompanionDiscoveryKind;
  source: CompanionDiscoverySource;
  /** 来源在它那一侧的稳定 id。**与笔记旁共用**（§7「共用收藏身份」）。 */
  sourceId: string;
  author: z.infer<typeof companionDiscoveryAuthorSchema>;
  /** 正文快照。用户后来改了原内容时它不动——它是"当时留下的那一段"。 */
  body: string;
  /** 用户自己的批注。与正文分开存：编辑批注不该改写原文。 */
  annotation: string | null;
  visibility: CompanionDiscoveryVisibility;
  createdAt: string;
  updatedAt: string;
}

export const companionDiscoveryEntryV1Schema = z.strictObject({
  entryId: z.string().uuid(),
  kind: companionDiscoveryKindSchema,
  source: companionDiscoverySourceSchema,
  sourceId: z.string().min(1).max(200),
  author: companionDiscoveryAuthorSchema,
  body: z.string().min(1).max(4000),
  annotation: z.string().max(2000).nullable(),
  visibility: companionDiscoveryVisibilitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 簿子页（一页就是全部——它按时间倒序，不分页到需要游标的程度）。 */
export const companionDiscoveryBookV1Schema = z.strictObject({
  version: z.literal(1),
  entries: z.array(companionDiscoveryEntryV1Schema),
  /** 书房可见的那几条（§7「书房仅展示用户愿意放出的少量痕迹」）。 */
  studyVisible: z.array(companionDiscoveryEntryV1Schema),
});

export type CompanionDiscoveryBookV1 = z.infer<typeof companionDiscoveryBookV1Schema>;

/** 书房最多露出几条。§7 说「**少量**」——不给数字就会慢慢涨成一面墙。 */
export const STUDY_TRACE_LIMIT = 6;

export type DiscoveryBlockReason =
  | "allowed"
  /** 不是用户本人，不能放进别人的簿子。 */
  | "not_owner"
  /** AI 建议没标作者 —— §7「标清作者和来源」。 */
  | "missing_author"
  /** `kept_ai_suggestion` 却标成 user：那是把 AI 的话冒充成用户自己的。 */
  | "ai_suggestion_authored_by_user"
  /** 日记摘录必须带日记来源，否则「不算本人理解」无从判断。 */
  | "excerpt_without_diary_source"
  /** 书房可见的条数超了。 */
  | "study_trace_limit";

/**
 * 一条要进簿子的内容，**允不允许**。
 *
 * 单独成一个纯函数，是因为这几条都是**记账之前**就该拦住的：一条作者标错的
 * 条目进了库，之后每个读它的页面都要替它判断"这是谁说的"，而那正是簿子要
 * 一开始就说清的事。
 */
export function evaluateDiscoveryEntry(input: {
  kind: CompanionDiscoveryKind;
  author: "user" | "assistant";
  source: CompanionDiscoverySource;
  ownerId: string;
  actorId: string;
  studyVisibleCount: number;
  wantStudyVisible: boolean;
}): { allow: boolean; reason: DiscoveryBlockReason } {
  if (input.ownerId !== input.actorId) return { allow: false, reason: "not_owner" };
  // §7「各自标清作者和来源」：作者是必填的枚举，不存在"没标"这一档。
  if (!input.author) return { allow: false, reason: "missing_author" };
  if (input.kind === "kept_ai_suggestion" && input.author !== "assistant") {
    return { allow: false, reason: "ai_suggestion_authored_by_user" };
  }
  if (input.kind === "diary_excerpt" && input.source !== "diary") {
    // A18：「标伴星与日记来源，不算本人理解」。来源不是日记就没法这样标。
    return { allow: false, reason: "excerpt_without_diary_source" };
  }
  if (input.wantStudyVisible && input.studyVisibleCount >= STUDY_TRACE_LIMIT) {
    return { allow: false, reason: "study_trace_limit" };
  }
  return { allow: true, reason: "allowed" };
}

/**
 * 取消收藏**不做**什么。
 *
 * §7：「取消收藏不删除原始回答或日记。」所以取消只让那一行**不可见**，
 * 原始内容一字不动。这条做成函数是因为它最容易被"顺手"写成级联删除——
 * 而那种错在界面上看不出来，只在某一天用户发现日记没了。
 */
export type UncollectEffect = "hide_entry_only";

export function uncollectEffect(): UncollectEffect {
  return "hide_entry_only";
}

/**
 * 同一份内容在两处出现时，它们是不是**同一条**。
 *
 * §7：「同一条内容在笔记旁和发现簿里出现时共用收藏身份，编辑批注或取消收藏
 * **同步生效**。」共用身份靠的是 (kind, source, sourceId) 这个组合——不是
 * 正文文本，所以原文改了也不会分裂成两条。
 */
export function sameCollectionIdentity(
  a: { kind: CompanionDiscoveryKind; source: CompanionDiscoverySource; sourceId: string },
  b: { kind: CompanionDiscoveryKind; source: CompanionDiscoverySource; sourceId: string },
): boolean {
  return a.kind === b.kind && a.source === b.source && a.sourceId === b.sourceId;
}

/**
 * 来源撤权或删除之后，这一行该怎么处理（§7「撤权或删除后缩略图、引文和预览
 * **同样处理**）。
 *
 * 注意它**不是**删掉那一行：删掉就看不出"这里曾经有过"，而 §7 要的是遮蔽。
 * 保留 `masked` 状态，簿子把它显示成占位而不是悄悄少一条。
 */
export type SourceLostAction = "mask_entry";

export function onSourceLost(): SourceLostAction {
  return "mask_entry";
}
