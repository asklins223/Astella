/**
 * LIKE / ILIKE 模式里的字面量转义。
 *
 * 为什么需要它：Postgres 的 `LIKE`/`ILIKE` 把 `%`（任意多字符）和 `_`（任意单字符）
 * 当通配符。用户输入如果原样拼进模式里，会有两个方向的坏结果：
 *
 *  1. **正确性**：搜 `%` 等于"匹配一切"，返回的却是"看起来像搜索结果"的列表。
 *  2. **性能（更糟）**：纯通配符模式里没有字面 trigram，GIN trigram 索引对它是
 *     失效的，于是退化成全表扫描 + 排序。单个请求就能把这个放大打出来。
 *
 * ⚠️ 用了这个函数就**必须**在 SQL 里带上 `ESCAPE '\'`。PG 默认的 LIKE 转义符
 * 确实是反斜杠，但那是"默认值"而不是"契约"——少写这个子句等于没转义。
 * `apps/api/src/modules/search/service.ts` 与
 * `apps/api/src/modules/companion-conversation/memory/continuous-history-service.ts`
 * 两处都带了。
 *
 * 2026-09-29（P1-12）从 `search/service.ts` 的模块私有 `searchEscapedQuery` 提上来：
 * 当时 `continuous-history-service.ts:153` 直接 `` `%${args.query}%` `` 没转义，
 * 而 `search` 那份已经写对了——同一件事两个实现，其中一个带 bug。
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}
