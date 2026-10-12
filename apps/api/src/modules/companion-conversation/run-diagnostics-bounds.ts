/**
 * 诊断件（replay 与 issue-bundle）的裁剪上界——**唯一**一份。
 *
 * 以前两份文件各自拄同一套数（receiptId 200 / name 80 / (0,16) / (0,64) / (0,201) / (0,200)），
 * 一份漂了另一份不会告警。诊断件拿去排障，裁了就等于销毁证据：
 * 这里把条数上界集中在一处，并把"有没有被剪"作为响应字段明说；
 * 单条字段长度不再逐条悄悄剪——合同那一层的 `.max(...)` 是唯一定义，超出由 parse 抛错。
 */
export const REPLAY_HANDOFF_MAX_BYTES = 524_288;
export const REPLAY_PROMPT_MESSAGE_MAX_COUNT = 64;
export const REPLAY_PROMPT_MESSAGE_MAX_CHARS = 16_000;
export const REPLAY_PROMPT_TOTAL_MAX_CHARS = 48_000;
export const DIAGNOSTIC_STEP_MAX_COUNT = 16;
export const DIAGNOSTIC_TOOL_CALL_MAX_COUNT = 64;
export const DIAGNOSTIC_LEDGER_ENTRY_MAX_COUNT = 64;
/** 时间线保留 200 条；SQL 侧多取 1 条做探针，只要拿到 limit+1 就说明"后面还有"。 */
export const DIAGNOSTIC_TIMELINE_EVENT_MAX_COUNT = 200;
export const DIAGNOSTIC_TIMELINE_EVENT_PROBE_LIMIT = DIAGNOSTIC_TIMELINE_EVENT_MAX_COUNT + 1;

/**
 * 收下"limit + 1"次查询的结果：没超限原样返回；超限了就丢探测行并说 truncated=true。
 * 与拓扑快照那本台账同一形状——客户端要能分得清"就这么多"与"被护栏截断"。
 */
export function boundedCollectionV1<TRow>(
  rows: readonly TRow[],
  limit: number,
): { items: TRow[]; truncated: boolean } {
  if (rows.length <= limit) return { items: [...rows], truncated: false };
  return { items: rows.slice(0, limit), truncated: true };
}
