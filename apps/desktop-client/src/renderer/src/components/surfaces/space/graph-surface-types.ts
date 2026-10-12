/** 星图的**筛选取值**（2026-09-30 从 `graph-surface.tsx` 搬出，供 hook 复用）。
 *
 * **一字未改**——搬，不是重写。 */
export type StateFilter = "all" | "attention" | "unseen" | "understood";

export type DeepeningLayer = "overview" | "local" | "records";

/** 右栏一份关系清单先列几条。两处（目标那侧的「真实光路」与笔记那侧的
 *  「正文里的引用」）共用一个数，否则同一个面板里两张清单会按两套尺度收起。 */
export const RELATION_ROW_LIMIT = 8;
