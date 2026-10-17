/**
 * **回访维度**的词表（39 §9.1 末段与规则表；W7-2 的 0287 那一列）。
 *
 * ## 这一列此前是空壳
 *
 * `review_schedules.review_dimension` 这列和它在 `pending` 上的部分唯一索引是真实
 * 存在的，边界函数也接受 `reviewDimension` 入参——但**没有任何生产调用方传过非空值**。
 * 于是那一格恒为 `""`，后果不是"少用了一列"：
 *
 *  - §9.1「事实提取与综合应用分别观察」不存在（两种需求塌成一格）；
 *  - §9.5「同一目标**同维度**的日程影响最多提交一次」只是因为维度恒空而**平凡成立**，
 *    不是被强制——真按维度排一次就会出现两条；
 *  - 「一个综合题只有满足某张卡对应目标的要求，才能减少该卡的重复练习」没有判据。
 *
 * ## 只有两档，而且只有一档是刻意的
 *
 * §9.1 那句话是「记住定义与在综合情境中使用」——**提取**与**应用**是两件事。
 * 一张卡背得熟不代表在综合情境里用得出来，反过来也一样；合成一格就等于把
 * "她记住了"当成"她会用了"，正是 §9.2「三种事实分开记录」要防的那件事。
 *
 * 第三档 `structural`（结构性／首次回访）**刻意不放在这里**：§9.1 说「首次回访与纯
 * 回顾提醒单独标明性质」，它靠的是 `reminder_kind` 那一根轴，不该挤进维度里——
 * 两件事挤在一列，就分不清"她要再练一次提取"和"这只是第一次回来看看"。
 */
export const REVIEW_DIMENSION_VALUES_V2 = ["recall", "apply"] as const;

export type ReviewDimensionV2 = (typeof REVIEW_DIMENSION_VALUES_V2)[number];

/** 空串 = 未指定维度（那一档**照样参与**唯一性，所以那一列不是可空的）。 */
export const REVIEW_DIMENSION_UNSPECIFIED_V2 = "";

/**
 * 一次观察服务的是哪一个维度。
 *
 * 这一条是唯一的判据，生产方与读侧都问它——两处各写一份的话，早晚会分叉成
 * "写入按 apply 过滤、读取按 recall 筛"，而那种错**不会让任何测试变红**。
 *
 * `transferSuitable` 是笔记轮次那侧已经算出来的形状：它为真表示这次问的是
 * "在综合情境里用"，否则只是把已教过的东西提取一遍。
 */
export function reviewDimensionForObservationV2(input: {
  /** 本次是"教过之后立刻在新情境里用"，还是"从记忆里提取"。 */
  readonly transferSuitable: boolean;
}): ReviewDimensionV2 {
  return input.transferSuitable ? "apply" : "recall";
}

/** 合法维度（含那一档"未指定"）。给 zod 与边界共用，避免两处各写一份枚举。 */
export function isReviewDimensionV2(value: unknown): value is ReviewDimensionV2 {
  return typeof value === "string"
    && (REVIEW_DIMENSION_VALUES_V2 as readonly string[]).includes(value);
}
