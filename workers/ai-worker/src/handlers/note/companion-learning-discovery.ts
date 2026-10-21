import { sql } from "drizzle-orm";
import { companionRecommendLearningV1Schema } from "@astella/shared";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { noteSearchTerms } from "../turn/companion-dialogue-content.ts";
import { recommendationToolResult, type AgentEventContext, type RecommendedLearningRow } from "../tools/companion-read-tools.ts";
import type { AgentToolExecutionResult } from "../tools/companion-tool-result.ts";

type CompanionLearningDiscoveryToolName = "companion_search_cards" | "companion_recommend_learning";

/** Executes scoped learning-card search and explicit recommendation lookup. */
export async function executeCompanionLearningDiscoveryTool(
  event: AgentEventContext,
  name: CompanionLearningDiscoveryToolName,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  switch (name) {
    case "companion_search_cards": {
      // 与笔记检索共用词切分和 all/any 语义；空词不能退化成 %% 扫整库。
      const query = String(args.query ?? "").trim();
      const limit = typeof args.limit === "number" ? Math.min(8, Math.max(1, args.limit)) : 5;
      const terms = noteSearchTerms(query);
      const anyMatch = args.match === "any";
      if (terms.length === 0) {
        return { value: { cards: [] }, safeSummary: "检索词是空的，我需要先知道要搜什么" };
      }
      const cardText = sql`concat_ws(' ', q.stem, c.note_id::text)`;
      const termConditions = terms.map((term) => sql`${cardText} ILIKE ${`%${term}%`}`);
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<{
          card_id: string;
          note_id: string;
          stem: string | null;
          question_type: string | null;
        }>(sql`
          SELECT c.id::text AS card_id,
                 c.note_id::text AS note_id,
                 q.stem AS stem,
                 q.question_type AS question_type
          FROM note_learning_cards c
          JOIN notes n ON n.id = c.note_id AND n.deleted_at IS NULL
          JOIN LATERAL (
            SELECT stem, question_type FROM note_learning_card_questions
            WHERE card_id = c.id ORDER BY ordinal LIMIT 1
          ) q ON true
          WHERE c.workspace_id = ${event.ctx.workspaceId}
            AND c.status = 'active'
            AND (n.share_scope = 'shared' OR n.created_by = ${event.read.userId})
            AND (${sql.join(termConditions, anyMatch ? sql` OR ` : sql` AND `)})
          ORDER BY (${sql.join(termConditions.map((condition) => sql`CASE WHEN ${condition} THEN 1 ELSE 0 END`), sql` + `)}) DESC,
                   c.updated_at DESC, c.id
          LIMIT ${limit}
        `),
      );
      const cards = rows.map((row) => {
        const stem = String(row.stem ?? "").replace(/\s+/g, " ").trim();
        return {
          cardId: row.card_id,
          noteId: row.note_id,
          title: (stem || "这张学习卡还没有题目").slice(0, 80),
          ...(stem ? { stem: stem.slice(0, 220) } : {}),
          ...(row.question_type ? { questionType: String(row.question_type) } : {}),
        };
      });
      return {
        value: { cards },
        safeSummary: cards.length > 0
          ? `找到 ${cards.length} 张${anyMatch ? "可核对的" : "相关"}学习卡`
          : `没有找到与「${query.slice(0, 20)}」相关的学习卡`,
      };
    }
    case "companion_recommend_learning": {
      // 三样各自一张表，一次查完。认的是 id，不是她自述的种类——学习卡那边递来的 id
      // 可能是 objective_id（`companion_open_card` 的别名规则），产物三张表也各有各的 id-space。
      // 这一条**故意不带 route**：带了的工具结果在 full 档会被自动执行（见 companion-tool-call-ledger），
      // 推荐五样就连跳五次屏。入口由 recommendation 块给，两种授权档都要用户自己点。
      const items = companionRecommendLearningV1Schema.parse(args).items;
      const noteIds = items.filter((item) => item.kind === "note").map((item) => item.targetId);
      const cardIds = items.filter((item) => item.kind === "card").map((item) => item.targetId);
      const artifactIds = items.filter((item) => item.kind === "artifact").map((item) => item.targetId);
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const found: RecommendedLearningRow[] = [];
          if (noteIds.length > 0) found.push(...await tx.execute<RecommendedLearningRow>(sql`
            SELECT 'note' AS source, n.title AS title, n.id::text AS id,
                   (EXTRACT(EPOCH FROM (now() - n.updated_at)) / 60)::int AS age_minutes
            FROM notes n
            WHERE n.workspace_id = ${event.ctx.workspaceId}
              AND n.deleted_at IS NULL
              AND (n.share_scope='shared' OR n.created_by=${event.read.userId})
              AND n.id = ANY(ARRAY[${sql.join(noteIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])
          `));
          if (cardIds.length > 0) {
            const anyCardKey = sql.join(cardIds.map((id) => sql`${id}::uuid`), sql`, `);
            found.push(...await tx.execute<RecommendedLearningRow>(sql`
              SELECT 'card' AS source,
                     coalesce(nullif(trim(q.stem), ''), '这张学习卡还没有题目') AS title,
                     c.id::text AS card_id,
                     (EXTRACT(EPOCH FROM (now() - c.updated_at)) / 60)::int AS age_minutes
              FROM note_learning_cards c
              JOIN notes n ON n.id = c.note_id AND n.deleted_at IS NULL
              LEFT JOIN LATERAL (
                SELECT stem FROM note_learning_card_questions
                WHERE card_id = c.id ORDER BY ordinal LIMIT 1
              ) q ON true
              WHERE c.workspace_id = ${event.ctx.workspaceId}
                AND c.status = 'active'
                AND (n.share_scope = 'shared' OR n.created_by = ${event.read.userId})
                AND c.id = ANY(ARRAY[${anyCardKey}]::uuid[])
            `));
          }
          if (artifactIds.length > 0) {
            const anyArtifactKey = sql.join(artifactIds.map((id) => sql`${id}::uuid`), sql`, `);
            // 速看没有自己的标题列，用所属笔记的标题（那一页上写的就是这篇的速看）。
            found.push(...await tx.execute<RecommendedLearningRow>(sql`
              SELECT 'artifact' AS source, a.title AS title, a.id::text AS id,
                     a.note_id::text AS note_id, a.note_version_id::text AS note_version_id,
                     a.generation_job_id::text AS task_id,
                     'note_dynamic_artifact' AS artifact_kind, a.source_kind AS source_kind,
                     (EXTRACT(EPOCH FROM (now() - a.created_at)) / 60)::int AS age_minutes
              FROM note_learning_artifacts a
              JOIN notes n ON n.id = a.note_id AND n.workspace_id = a.workspace_id
              WHERE a.workspace_id = ${event.ctx.workspaceId} AND a.user_id = ${event.read.userId}
                AND n.deleted_at IS NULL
                AND (n.share_scope = 'shared' OR n.created_by = ${event.read.userId})
                AND a.id = ANY(ARRAY[${anyArtifactKey}]::uuid[])
              UNION ALL
              SELECT 'artifact', m.title, m.id::text, m.note_id::text, m.note_version_id::text,
                     m.generation_job_id::text, 'note_mind_map', NULL::text,
                     (EXTRACT(EPOCH FROM (now() - m.created_at)) / 60)::int
              FROM note_mind_maps m
              JOIN notes n ON n.id = m.note_id AND n.workspace_id = m.workspace_id
              WHERE m.workspace_id = ${event.ctx.workspaceId} AND m.user_id = ${event.read.userId}
                AND n.deleted_at IS NULL
                AND (n.share_scope = 'shared' OR n.created_by = ${event.read.userId})
                AND m.id = ANY(ARRAY[${anyArtifactKey}]::uuid[])
              UNION ALL
              SELECT 'artifact', n.title, o.id::text, o.note_id::text, o.note_version_id::text,
                     o.generation_job_id::text, 'note_overview', NULL::text,
                     (EXTRACT(EPOCH FROM (now() - o.created_at)) / 60)::int
              FROM note_overviews o
              JOIN notes n ON n.id = o.note_id AND n.workspace_id = o.workspace_id AND n.deleted_at IS NULL
              WHERE o.workspace_id = ${event.ctx.workspaceId} AND o.user_id = ${event.read.userId}
                AND (n.share_scope = 'shared' OR n.created_by = ${event.read.userId})
                AND o.id = ANY(ARRAY[${anyArtifactKey}]::uuid[])
            `));
          }
          return found;
        },
      );
      return recommendationToolResult(items, rows);
    }
    default:
      throw new Error("Unsupported companion learning discovery tool");
  }
}
