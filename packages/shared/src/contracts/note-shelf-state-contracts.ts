import { z } from "zod";

/**
 * 笔记架纸签只报告已保存的产物和记录，不推断它们被用户看过。
 * 方案 41 §5 区分生成、观看、自述与测评；这里没有观看回执或掌握度评分。
 */

/** 一篇笔记上真实保存的产物与记录；不表示用户已经阅读了产物。 */
export const noteShelfLearningFactsV1Schema = z.strictObject({
  /** 有过整篇速看记录（`note_overviews`）。 */
  overviewCount: z.number().int().nonnegative(),
  /** 最近一次速看记在哪一版上。笔记改版后这个数字会小于当前版本号。 */
  overviewVersionNumber: z.number().int().positive().nullable(),
  /** 有过回想记录（`note_recall_records`），无论当时自述为想起、部分还是没想起。 */
  recallCount: z.number().int().nonnegative(),
  /** 最近一次回想自述——「自己说想起来了」是一个独立事实，不等于「练过了」。 */
  lastRecallSelfReport: z.enum(["remembered", "partly", "not_yet"]).nullable(),
  /** 原位批注条数（`note_annotations`）。 */
  annotationCount: z.number().int().nonnegative(),
  /** 互动讲解份数（`note_learning_artifacts`）。 */
  artifactCount: z.number().int().nonnegative(),
  /** 确认收下、真的长成新笔记的条数（`note_expansions`）。 */
  expansionCount: z.number().int().nonnegative(),
  /** 这些痕迹里最近的一次落在哪一版上。 */
  latestVersionNumber: z.number().int().positive().nullable(),
  /** 最近一次留下痕迹的时间。 */
  latestAt: z.string().datetime({ offset: true }).nullable(),
});
export type NoteShelfLearningFactsV1 = z.infer<typeof noteShelfLearningFactsV1Schema>;

/**
 * 纸签上的一个词。它说的是**发生过什么**，不是「你掌握得怎么样」——
 * 界面上任何一个词都不得读成评分。
 */
export const noteShelfStageV1Schema = z.enum([
  /** 还没写正文。 */
  "draft",
  /** 有正文，但一条学习痕迹都没有。 */
  "untouched",
  /** 已保存速看卡，尚无更深的记录。 */
  "skimmed",
  /** 已保存回想记录，但这不等于正式练习。 */
  "recalled",
  /** 原位问过某几句，钻进去过。 */
  "annotated",
  /** 从这篇长出去过新笔记。 */
  "grew",
]);
export type NoteShelfStageV1 = z.infer<typeof noteShelfStageV1Schema>;

export const noteShelfStateV1Schema = z.strictObject({
  facts: noteShelfLearningFactsV1Schema,
  stage: noteShelfStageV1Schema,
  /**
   * 笔记在痕迹之后又改过版。这时旧痕迹仍在、仍可点回去，但不能说是「你看的是
   * 现在这一篇」——41 §5 说的就是这个：能确认同一位置才重新挂靠。
   */
  editedAfterLearning: z.boolean(),
});
export type NoteShelfStateV1 = z.infer<typeof noteShelfStateV1Schema>;

/**
 * 一处签发。界面上的纸签文字、排序权重和筛选都读这里，不许各写一遍。
 *
 * 取信息最多的记录，不推断此前每种产物都被阅读过。
 * 顺序为：拓展 > 批注 > 回想 > 速看 > 无记录。
 */
export function noteShelfStageV1(input: {
  hasBody: boolean;
  facts: NoteShelfLearningFactsV1;
}): NoteShelfStageV1 {
  if (!input.hasBody) return "draft";
  const { facts } = input;
  if (facts.expansionCount > 0) return "grew";
  if (facts.annotationCount > 0) return "annotated";
  if (facts.recallCount > 0) return "recalled";
  if (facts.overviewCount > 0) return "skimmed";
  return "untouched";
}

/** 纸签上的那一个词。人话，不是系统词。 */
export const NOTE_SHELF_STAGE_LABEL_V1: Record<NoteShelfStageV1, string> = {
  draft: "空稿",
  untouched: "暂无学习记录",
  skimmed: "速看已备",
  recalled: "有回想记录",
  annotated: "有原位批注",
  grew: "有关联笔记",
};

/**
 * 副签列出可数的记录，不表示学习进度或掌握度。
 */
export function noteShelfStageDetailV1(
  facts: NoteShelfLearningFactsV1,
): readonly string[] {
  const detail: string[] = [];
  if (facts.overviewCount > 0) detail.push(`${facts.overviewCount} 张速看`);
  if (facts.recallCount > 0) detail.push(`${facts.recallCount} 条回想`);
  if (facts.annotationCount > 0) detail.push(`${facts.annotationCount} 处批注`);
  if (facts.artifactCount > 0) detail.push(`${facts.artifactCount} 份互动讲解`);
  if (facts.expansionCount > 0) detail.push(`关联 ${facts.expansionCount} 篇`);
  return detail;
}

/** 排序与筛选用的档位。数字越小越「生」。 */
export const NOTE_SHELF_STAGE_RANK_V1: Record<NoteShelfStageV1, number> = {
  draft: 0,
  untouched: 1,
  skimmed: 2,
  recalled: 3,
  annotated: 4,
  grew: 5,
};
