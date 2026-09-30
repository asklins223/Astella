/** 星图的**筛选取值**（2026-09-30 从 `graph-surface.tsx` 搬出，供 hook 复用）。
 *
 * **一字未改**——搬，不是重写。 */
export type StateFilter = "all" | "attention" | "unseen" | "understood";

export type DeepeningLayer = "overview" | "local" | "records";
