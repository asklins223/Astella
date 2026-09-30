/**
 * F-024: 统一分页参数 clamp 工具。
 *
 * limit 限定到 1–`max`（默认 100），offset/cursor 限定到 ≥0。
 * 负值或 NaN 会被纠正为默认值，而非触发 500。
 *
 * 2026-09-29（P1-17）：加了 `max` 参数。原因是此前上界硬编码 100，
 * 于是 audit(200) / observability(500) 这类路由**用不了**它，只能各自手写
 * `Math.min(Math.max(x, 1), 200)`——全仓因此有十几处手写 clamp，其中 3 处
 * **漏了下界**（`?limit=0` 或负数原样进查询，其中 `delivery-service.ts` 那一处
 * 还会 `Math.min(undefined, 100)` 得到 NaN）。
 *
 * 有了 `max` 之后，那几处可以直接换成这个函数，NaN 也一并被兜住。
 */
export function clampLimit(value: number | string | undefined | null, defaultValue = 100, max = 100): number {
  // 2026-09-29（P1-4）：形参放宽到 **string**。
  //
  // 理由是实打实的：`req.query.limit` 的类型就是 `string | undefined`，
  // 而手写那 11 处里有 1 处（note/routes.ts）必须先 `Number(...)` 才能传进来——
  // 也就是说收口之后每个路由都要多写一次本地转型。
  //
  // 更要紧的是：**字符串是 NaN 漏洞的主要来源**。
  // `?limit=abc` 到手是字符串，不转就是 NaN；而 11 处手写 clamp 里有 10 处
  // 确实会漏（`Math.min(Math.max(NaN, 1), 100)` 仍是 NaN），drizzle 拿到 NaN
  // **不渲染 LIMIT**，端点直接退化成全表扫描。
  // 形参收下字符串，就让"忘了转型"这件事不可能发生，而不是指望每个调用点记得。
  // 空白串当"没给"处理。`?limit=` 到手是 ""，而 `Number("")` 是 **0**——
  // 0 是有限数，于是直接被下界抬成 1，用户留空反而只拿到一条。
  // 语义上留空就是没填，回默认值才对。
  if (typeof value === "string" && value.trim() === "") return defaultValue;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (numeric === undefined || numeric === null || !Number.isFinite(numeric)) return defaultValue;
  const upper = Math.max(1, Math.floor(max));
  return Math.max(1, Math.min(upper, Math.floor(numeric)));
}

/**
 * offset 限定到 `0..max`（默认 10000）。
 *
 * 2026-09-29（P3-8）：此前**只有下界**。`?offset=10000000` 会原样进查询，
 * 而 Postgres 的 OFFSET 是"扫过再丢掉"——`OFFSET 10_000_000 LIMIT 50`
 * 仍然要把前面一千万行读出来再扔掉。三条用到它的端点
 * （identity 的 AI 审计日志、邀请码列表、卡片列表）都直接把它交给
 * `.offset()`，所以这是一个"一个 query 参数换来一次全表扫描"的形状。
 *
 * **为什么是封顶而不是改 keyset**：keyset 才是正解，但那要改三个端点的
 * 排序与游标形状（对外契约跟着变）。封顶是同一条治本的**兜底**——
 * 它保证"单次翻页的代价有界"，而 keyset 解决的是"翻页本身不随深度变贵"。
 * 两件事都该做，先做不会再变贵的那一件。
 *
 * 10_000 的来由：按每页 50 条算是第 200 页，再往后的翻页本来就该换成
 * keyset；换句话说，这个上限卡的是"不该被接受的用法"，不是正常浏览。
 *
 * 形参与 `clampLimit` 一致地收下 **string**：`req.query.offset` 到手就是
 * `string | undefined`，不转型就传进来是这一类 NaN 漏洞的来源。
 */
export function clampOffset(
  value: number | string | undefined | null,
  defaultValue = 0,
  max = 10_000,
): number {
  if (typeof value === "string" && value.trim() === "") return defaultValue;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (numeric === undefined || numeric === null || !Number.isFinite(numeric)) return defaultValue;
  const lower = Math.max(0, Math.floor(defaultValue));
  const upper = Math.max(lower, Math.floor(max));
  return Math.max(lower, Math.min(upper, Math.floor(numeric)));
}

export function clampPagination(opts?: { cursor?: number; limit?: number }, defaults?: { limit?: number; cursor?: number }) {
  return {
    limit: clampLimit(opts?.limit, defaults?.limit ?? 100),
    offset: clampOffset(opts?.cursor, defaults?.cursor ?? 0),
  };
}

/**
 * R-019: Cursor 分页工具。
 *
 * 将 offset 分页迁移为基于 (timestamp, id) 的 cursor 分页。
 * cursor 是 base64 编码的 "timestamp:id" 字符串。
 * 避免并发插入/更新导致的重复或遗漏。
 */

/**
 * 编码 cursor：将 timestamp 和 id 编码为 base64 字符串。
 */
export function encodeCursor(timestamp: string | Date, id: string): string {
  const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  return Buffer.from(`${ts}:${id}`).toString("base64");
}

/**
 * 解码 cursor：将 base64 字符串解码为 { timestamp, id }。
 * 返回 null 表示无效 cursor（等价于第一页）。
 */
export function decodeCursor(cursor: string | undefined | null): { timestamp: string; id: string } | null {
  if (!cursor) return null;
  try {
    if (
      cursor.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)
    ) return null;
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    // Buffer's base64 decoder is deliberately forgiving. Require the canonical
    // representation emitted by encodeCursor so garbage is not treated as page 1.
    if (Buffer.from(decoded, "utf-8").toString("base64") !== cursor) return null;
    const sepIndex = decoded.lastIndexOf(":");
    if (sepIndex <= 0) return null;
    const timestamp = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (
      !timestamp ||
      Number.isNaN(Date.parse(timestamp)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
}

/**
 * R-022: 统一 Zod query schema — 所有列表端点共用。
 * 校验失败时返回 400，而非静默退回默认值。
 */
import { z } from "zod";

// R-019: cursor 改为 string 类型（base64 编码的 timestamp:id）
export const paginationQuerySchema = z.object({
  cursor: z.string().max(200).refine((value) => decodeCursor(value) !== null, {
    message: "invalid cursor",
  }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

// R-022: cardId 路径参数校验
export const cardIdParamSchema = z.object({
  cardId: z.string().uuid(),
});
