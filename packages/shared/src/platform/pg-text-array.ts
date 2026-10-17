/**
 * PostgreSQL `text[]` 参数的字面量序列化。
 *
 * ## 为什么不能直接把 JS 数组当参数传
 *
 * 项目用的是 **postgres.js**（`drizzle-orm/postgres-js` 驱动）。它把一个 JS 数组
 * 序列化成**行构造器** `($1, $2)`，而不是数组字面量 `{a,b}`。行构造器在
 * `WHERE x IN (...)` 里有意义，但在往 `text[]` 列 INSERT/UPDATE 时不是同一个类型：
 *
 * ```
 * SELECT ('a','b')::text[]   → column is of type text[] but expression is of type record
 * SELECT ()::text[]          → syntax error at or near ")"
 * ```
 *
 * 也就是说，**数组参数配 `::text[]` 转换必炸**：空数组炸语法错误，非空数组炸类型错误。
 * 两边都只在真的执行到那条语句时暴露，写单测（不连库）永远发现不了。
 *
 * ## 这条链上已经因此出过两次事故
 *
 * - 2026-09-30 起伴星日记连续 6 天一篇都没落库：日记发布语句把
 *   `source_event_ids` 的 JS 数组直接塞进 `text[]` 列，成功与失败两条分支都炸
 *   （失败分支是空数组 `()`，成功分支是行构造器）。模型每天照样写完了稿，
 *   全在最后一步 INSERT 上废掉，job 3 次重试后 dead。
 * - 同一写法还留在撤权遮蔽日记的读路径与 judgment 记忆写入路径上。
 *
 * 所以正确写法只有一条：**在应用侧拼出 PostgreSQL 数组字面量**，再交给
 * `::text[]` 转换。转义规则按 PostgreSQL 文档的数组字面量语法：元素用双引号
 * 包裹，元素内的 `\` 与 `"` 各自先转义。
 */

/** 将字符串数组序列化为可安全拼进 SQL 的 PostgreSQL `text[]` 字面量。 */
export function toTextArrayLiteral(values: readonly string[]): string {
  const items = values.map((value) => {
    const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
  return `{${items.join(",")}}`;
}
