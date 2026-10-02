/**
 * 桌宠日记只读 API（22-real-desktop-pet-memory-context-prd-tdd.md §15.3）。
 *
 * GET /companion/daily?date=YYYY-MM-DD
 * - 只读，不触发生成；
 * - date 缺省返回最近一次已生成日记；
 * - status = generated | not_generated | failed；
 * - 未来日期返回 not_generated，不报错。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { requireSession } from "../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { companionDailySummaries } from "@ailearn/shared/db-schema/companion-memory";

function isDailySummaryEnabled(): boolean {
  // §15.3：该 flag 独立于 COMPANION_JOURNEY_V2，默认关闭，.env 显式开启。
  return process.env.COMPANION_DAILY_SUMMARY_V1 === "true";
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * 月历标记要的那个月的第一天/最后一天。
 *
 * 自己拼日期而不是 `date BETWEEN month || '-01' AND month || '-31'`：
 * 2 月没有 31 日，字符串区间会把别的月份漏进来或漏出去。
 */
function monthRange(month: string): { readonly from: string; readonly to: string } {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(year, number, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * 撤销材料访问后，遮蔽由该材料生成的日记与它的派生摘录（40 §11.1 第 6 行 / A13）。
 *
 * ## 为什么要单独一个服务函数，而不是只在路由里做
 *
 * 撤权有不止一个入口（笔记 share_scope 改回 private、笔记删除、来源删除），
 * 而**漏掉一个的后果**恰好是合同点名的那一条：日记正文里仍然写着那句已经被
 * 收回权限的材料，而且用户看不出它已经过期。放进服务函数，三条路径都调同一处。
 *
 * ## 「无法安全拆分时整篇不可读」
 *
 * 我们无法从正文里逐句判断哪一句来自哪份材料——日记正文是一段连续的自由文本。
 * 所以这里选的是另一端：**只要这篇日记用过已被撤权的材料，整篇就不给读**。
 * §11.1 的原话是「日记正文中的复述、图片、引文、摘录同步遮蔽；无法安全拆分时
 * 整篇不可读」，这是那句话里唯一可执行的一侧。
 *
 * `sourceRefs` 是这一篇用过的材料标识。拿不到就**不遮蔽**——宁可漏遮一次，
 * 也不能在没有证据的情况下把用户自己的日记弄没了。
 */
export async function maskDiaryAndExcerptsForRevokedSources(
  executor: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  input: { eventIds: readonly string[] },
): Promise<{ maskedDiaryDates: string[]; maskedEntries: number }> {
  const ids = input.eventIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { maskedDiaryDates: [], maskedEntries: 0 };

  // 一次查全：GIN 索引在 source_event_ids 上，`&&` 是数组相交。
  const rows = await executor.execute<{ date: string }>(sql`
    UPDATE companion_daily_summaries
       SET deleted_at = now(), delete_reason = 'revoked_source',
           hidden_at = COALESCE(hidden_at, now()), updated_at = now()
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND deleted_at IS NULL
       AND source_event_ids && ${ids}::text[]
    RETURNING date
  `);
  const dates = (Array.isArray(rows) ? rows : []).map((row) => row.date);
  if (dates.length === 0) return { maskedDiaryDates: [], maskedEntries: 0 };

  // 摘录与预览只遮蔽不物理删：材料可能重新可访问，那时还要能放回来。
  const masked = await executor.execute<{ id: string }>(sql`
    UPDATE companion_discovery_entries
       SET masked = true, updated_at = now()
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND source = 'diary'
       AND source_id = ANY(${dates}::text[])
       AND NOT masked
    RETURNING id
  `);
  return { maskedDiaryDates: dates, maskedEntries: (Array.isArray(masked) ? masked : []).length };
}

export async function dailySummaryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    if (!isDailySummaryEnabled()) {
            return reply.code(404).send({
        error: "companion_daily_summary_disabled",
        message: "桌宠日记当前未开放",
      });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/daily",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const rawDate = req.query?.date;
      const parsed = rawDate === undefined ? null : dateSchema.safeParse(rawDate);
      if (rawDate !== undefined && !parsed?.success) {
        throw app.httpErrors.badRequest("date 非法，应为 YYYY-MM-DD");
      }
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, async (tx) => {
        const conditions = [
          eq(companionDailySummaries.workspaceId, scope.workspaceId),
          eq(companionDailySummaries.userId, scope.userId),
          // 已删除的篇目不返回：§10「删除日记」删的是这篇作品本身。
          // 删掉之后用户看到的应该是"这一天没有留下日记"，而不是一个 404。
          isNull(companionDailySummaries.deletedAt),
        ];
        if (parsed?.success) {
          conditions.push(eq(companionDailySummaries.date, parsed.data));
        }
        const rows = await tx
          .select()
          .from(companionDailySummaries)
          .where(and(...conditions))
          .orderBy(desc(companionDailySummaries.date))
          .limit(1);
        return rows[0] ?? null;
      });

      if (!result) {
        return reply.header("Cache-Control", "no-store").send({
          version: 1,
          date: parsed?.success ? parsed.data : null,
          status: "not_generated",
          generatedAt: null,
          failureReason: null,
          selectionReason: null,
          // 没有成稿 ⇒ 也就没有"她选了哪一段"。如实给 null，不编一个。
          // （这一栏是 A56「正文与选中 ID 一致」事后核对用的，所以它必须
          //   忠实反映库里那一列，不能在读路径上被补齐成什么。）
          selectedId: null,
          revision: 1,
          blocks: [],
          memory: null,
        });
      }

      // §15.3/§15.5：查找与该日记关联的候选记忆（source_event_id = daily-summary:<date>）。
      const memory = await withWorkspaceTransaction(scope, async (tx) => {
        const sourceEventId = `daily-summary:${result.date}`;
        const rows = await tx.execute<{ id: string; candidate: boolean }>(sql`
          SELECT id, candidate FROM assistant_memory_items
          WHERE workspace_id = ${scope.workspaceId}
            AND user_id = ${scope.userId}
            AND source_event_id = ${sourceEventId}
            AND deleted_at IS NULL
          LIMIT 1
        `);
        const row = (Array.isArray(rows) ? rows : [])[0];
        return row ? { memoryItemId: row.id, candidate: row.candidate } : null;
      });

      // 0252 之前的历史行只有 `summary`（`blocks='[]'`）。在这里投影成一个 text 块，
      // 而不是让渲染层为"旧日子没有块"写分支——用户裁定旧日子不重写，但它们照常显示。
      const storedBlocks = Array.isArray(result.blocks) ? result.blocks : [];
      const blocks = storedBlocks.length > 0
        ? storedBlocks
        : result.summary ? [{ type: "text", text: result.summary }] : [];

      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        date: result.date,
        status: result.status,
        generatedAt: result.generatedAt.toISOString(),
        failureReason: result.failureReason,
        selectionReason: result.selectionReason,
        selectedId: result.selectedId,
        // 「聊聊这篇」要带的版本号（§6）。§5.5 保证已发布成稿不被后台重跑替换，
        // 所以这个号在用户看到它的那一刻是稳定的。
        revision: result.revision,
        // §10：「隐藏日记」从普通列表与主动推荐中移除该篇，但用户仍可从管理入口
        // 恢复或明确打开。所以它要能被明确打开——只是不进普通列表。
        hidden: result.hiddenAt !== null,
        hiddenAt: result.hiddenAt ? result.hiddenAt.toISOString() : null,
        blocks,
        memory,
      });
    },
  );

  /**
   * 「隐藏日记」（40 §10）——**不是删除**。
   *
   * 合同把这两件事分开写，而且给了不同的后果：
   *   - 隐藏：从普通列表与主动推荐中移除该篇，**并排除后续自动日记引用**；
   *     用户可从管理入口恢复或明确打开；「它不删除内容，也不等于遗忘原事件」。
   *   - 删除：删掉作品及其派生预览与摘录。
   *
   * 所以这里**不写来源抑制表**。写了就等于用户因为「不想看到这篇日记」而
   * 真的让那次交流从她的记忆里消失——那是遗忘，用户没有要求遗忘。
   * 「排除后续自动日记引用」由 `hidden_at` 参与选材过滤来实现（见
   * companion-daily-summary 的 material 查询）。
   */
  app.post<{ Params: { date: string } }>(
    "/companion/daily/:date/hide",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = dateSchema.safeParse(req.params.date);
      if (!parsed.success) throw app.httpErrors.badRequest("date 非法，应为 YYYY-MM-DD");
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          UPDATE companion_daily_summaries
             SET hidden_at = now(), updated_at = now()
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND date = ${parsed.data}
             AND deleted_at IS NULL
             AND hidden_at IS NULL
          RETURNING id
        `);
        return (Array.isArray(rows) ? rows : []).length > 0;
      });
      // 幂等：重复点隐藏不该报错——那只会让界面显示一个红条。
      return reply.header("Cache-Control", "no-store").send({ version: 1, hidden: true, changed: result });
    },
  );

  /** 取消隐藏。删除过的篇目恢复不了（那是另一条路由，且要显式说明范围）。 */
  app.post<{ Params: { date: string } }>(
    "/companion/daily/:date/unhide",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = dateSchema.safeParse(req.params.date);
      if (!parsed.success) throw app.httpErrors.badRequest("date 非法，应为 YYYY-MM-DD");
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          UPDATE companion_daily_summaries
             SET hidden_at = NULL, updated_at = now()
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND date = ${parsed.data}
             AND deleted_at IS NULL
             AND hidden_at IS NOT NULL
          RETURNING id
        `);
        return (Array.isArray(rows) ? rows : []).length > 0;
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, hidden: false, changed: result });
    },
  );

  /**
   * 「删除日记」（40 §10/§11.1 第 4 行）。
   *
   * 连带清掉的东西（合同逐项列了，这里逐项做）：
   *   - 该篇作品的派生预览 —— 同 `source='diary', source_id=<date>` 的发现簿行；
   *   - 发现簿里的日记摘录 —— 同上，`kind='diary_excerpt'`；
   *   - **仅由该篇产生的记忆** —— `source_event_id = 'daily-summary:<date>'` 的那一条。
   *
   * 「原始聊天/学习事件不默认删除」：这里只删由日记派生出来的东西，
   * `companion_messages` 一行不动。理由是那天的对话本身仍然发生过。
   *
   * 抑制墓碑：删掉的那条记忆要写抑制，否则下一次整理/抽取会把它重新记起来。
   */
  app.post<{ Params: { date: string } }>(
    "/companion/daily/:date/delete",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = dateSchema.safeParse(req.params.date);
      if (!parsed.success) throw app.httpErrors.badRequest("date 非法，应为 YYYY-MM-DD");
      const scope = scopeOfSession(req.session);
      const sourceEventId = `daily-summary:${parsed.data}`;
      const outcome = await withWorkspaceTransaction(scope, async (tx) => {
        const deleted = await tx.execute<{ id: string }>(sql`
          UPDATE companion_daily_summaries
             SET deleted_at = now(), delete_reason = 'user_deleted',
                 hidden_at = COALESCE(hidden_at, now()), updated_at = now()
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND date = ${parsed.data}
             AND deleted_at IS NULL
          RETURNING id
        `);
        if ((Array.isArray(deleted) ? deleted : []).length === 0) {
          return { diary: false, entries: 0, memories: 0 };
        }
        // 派生预览与摘录：物理删除而不是遮蔽——用户说「删掉」。
        const entries = await tx.execute<{ id: string }>(sql`
          DELETE FROM companion_discovery_entries
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND source = 'diary'
             AND source_id = ${parsed.data}
          RETURNING id
        `);
        const memories = await tx.execute<{ id: string; kind: string }>(sql`
          DELETE FROM assistant_memory_items
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND source_event_id = ${sourceEventId}
             AND deleted_at IS NULL
          RETURNING id, kind
        `);
        const memoryRows = Array.isArray(memories) ? memories : [];
        for (const row of memoryRows) {
          await tx.execute(sql`
            INSERT INTO assistant_memory_source_suppressions (user_id, kind, source_event_id)
            VALUES (${scope.userId}, ${row.kind}, ${sourceEventId})
            ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
          `);
        }
        return {
          diary: true,
          entries: (Array.isArray(entries) ? entries : []).length,
          memories: memoryRows.length,
        };
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, ...outcome });
    },
  );

  /**
   * 撤权导致的**整篇遮蔽**（§11.1 第 6 行 / A13）。
   *
   * 与用户主动删除分开：这一路的 delete_reason 是 `revoked_source`，语义是
   * 「材料已不可访问，正文里的复述不该再被读到」。发现簿摘录同样遮蔽。
   *
   * 撤权是**不可逆的用户动作**（权限本来就收不回来），所以这里不提供恢复端点——
   * 提供了就是骗人。材料重新获得访问时由撤权流程自己决定要不要重写。
   */
  app.post<{ Params: { date: string } }>(
    "/companion/daily/:date/mask",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = dateSchema.safeParse(req.params.date);
      if (!parsed.success) throw app.httpErrors.badRequest("date 非法，应为 YYYY-MM-DD");
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          UPDATE companion_daily_summaries
             SET deleted_at = now(), delete_reason = 'revoked_source',
                 hidden_at = COALESCE(hidden_at, now()), updated_at = now()
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND date = ${parsed.data}
             AND deleted_at IS NULL
          RETURNING id
        `);
        // 摘录与预览只遮蔽不物理删：材料可能重新可访问，那时还要能放回来。
        const masked = await tx.execute<{ id: string }>(sql`
          UPDATE companion_discovery_entries
             SET masked = true, updated_at = now()
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND source = 'diary'
             AND source_id = ${parsed.data}
             AND NOT masked
          RETURNING id
        `);
        return { diary: (Array.isArray(rows) ? rows : []).length > 0, masked: (Array.isArray(masked) ? masked : []).length };
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, ...result });
    },
  );

  /**
   * 月历标记：这个月里她写过（或试过）哪几天。
   *
   * 表上没有 (workspace, user, date) 的唯一约束，重跑一天可以留下两行，所以这里
   * 按天聚合：**只要有一天写成过，那一天就是写过**，否则算她试过没写成。
   * 没写的日子根本不出现在结果里——「缺席」不是这里的一种状态。
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/daily/month",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = monthSchema.safeParse(req.query?.month);
      if (!parsed.success) {
        throw app.httpErrors.badRequest("month 非法，应为 YYYY-MM");
      }
      const { from, to } = monthRange(parsed.data);
      const scope = scopeOfSession(req.session);
      const rows = await withWorkspaceTransaction(scope, async (tx) => tx
        .select({
          date: companionDailySummaries.date,
          written: sql<boolean>`bool_or(${companionDailySummaries.status} = 'generated')`,
        })
        .from(companionDailySummaries)
        .where(and(
          eq(companionDailySummaries.workspaceId, scope.workspaceId),
          eq(companionDailySummaries.userId, scope.userId),
          // 已删除的那天不算「写过」：月历标记是给她这一天的存在感的，
          // 用户已经把作品删掉之后再显示一个绿点，是在提示一个不存在的东西。
          isNull(companionDailySummaries.deletedAt),
          gte(companionDailySummaries.date, from),
          lte(companionDailySummaries.date, to),
        ))
        .groupBy(companionDailySummaries.date)
        .orderBy(companionDailySummaries.date));

      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        month: parsed.data,
        days: rows.map((row) => ({ date: row.date, status: row.written ? "generated" as const : "failed" as const })),
      });
    },
  );
}
