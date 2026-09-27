/**
 * Plan 23 TP-08：Understanding Topology V3 routes。
 *
 * GET /v3/understanding/topology —— V3 snapshot（ETag / If-None-Match → 304）
 * GET /v3/understanding/relation-decisions —— 本人对建议关系的表态（§11.3、§16.20）
 * POST /v3/understanding/relation-decisions —— 记一次表态／撤销一次
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { buildTopologySnapshotV3Cached, readTopologySnapshotCache } from "./topology-repository.ts";
import {
  RelationEndpointNotReadableV2,
  RelationSelfLoopV2,
  applyPersonalDecisionsToSnapshotV2,
  listPersonalRelationDecisionsV2,
  personalDecisionsETagSuffixV2,
  setPersonalRelationDecisionV2,
} from "./personal-relation-decision-service.ts";
import {
  setPersonalRelationDecisionV2Schema,
  type PersonalRelationDecisionV2,
} from "@ailearn/shared/personal-relation-decision-rules-v2";

export async function understandingTopologyV3Routes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v3/understanding/topology", async (req, reply) => {
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    // AI-perf #4（2026-09-15 审计）：先查 TTL 缓存——命中时**完全不开启事务**，
    // 于是 304 路径零 DB 成本。此前每次请求都重建整份快照（15 个串行 await /
    // 16 条语句 / 无 LIMIT 全量读）之后才比较 If-None-Match，ETag 协商只省带宽、
    // 省不下 DB。缓存语义与陈旧上界见 topology-repository.ts 的 TTL 说明。
    const cached = readTopologySnapshotCache(ctx);
    const snapshot = cached ?? await withWorkspaceTransaction(ctx, (tx) =>
      buildTopologySnapshotV3Cached(tx, ctx),
    );

    /**
     * 本人的表态在**出网前**叠上去，而不是折进缓存或折进 `topologyRevision`。
     *
     * 两个理由，都写在 `applyPersonalDecisionsToSnapshotV2` 的头注里：
     * 公共拓扑被本人的看法污染（§11.3 那一句的反面），以及指纹会变成 per-user 的。
     *
     * **代价是要多一次读**，所以只在缓存没命中时也走一次轻量查询；命中的那条路径
     * 此前是"零 DB 成本"，这里多了一条只按 (workspace, user) 过滤的小查询——
     * 用「零成本」换「用户的确认真的会生效」是划算的，因为不换的话 304 会把它吃掉。
     */
    const decisions = await withWorkspaceTransaction(ctx, (tx) =>
      listPersonalRelationDecisionsV2(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId }),
    );
    const { edges, decisionByEdgeId } = applyPersonalDecisionsToSnapshotV2({
      snapshot,
      // `toView` 出来的 `relation` 是四个具体值的联合、`decision` 是两档的联合；
      // 投影那一侧的入参写得更宽（`string`），这里由 zod 合同保证它不会跑到别的值。
      decisions: decisions.map((d) => ({
        fromObjectiveId: d.fromObjectiveId,
        toObjectiveId: d.toObjectiveId,
        relation: d.relation as string,
        decision: d.decision as PersonalRelationDecisionV2,
      })),
    });
    const projected = { ...snapshot, edges };

    // **ETag 必须掺进本人的表态摘要**：`topologyRevision` 只哈希两端点与 kind，
    // ��户点完「确认」之后指纹逐字节不变 ⇒ 同一 If-None-Match 拿到 304 ⇒
    // 他刚点的确认留在屏上不生效，且没有任何错误。这是四条里唯一静默失效的一条。
    const etag = '"' + snapshot.topologyRevision + "-" +
      personalDecisionsETagSuffixV2(
        Object.entries(decisionByEdgeId).map(([edgeId, decision]) => ({ edgeId, decision })),
      ) + '"';
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("etag", etag);
    // no-cache（而非 no-store）：每次协商，304 可达。缺此头时协商缓存依赖
    // 客户端启发式刷新，304 不可靠。
    reply.header("cache-control", "private, no-cache");
    return projected;
  });

  /** 本人在某一篇（或整个空间）上做过的全部表态。 */
  app.get("/v3/understanding/relation-decisions", async (req, reply) => {
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    const query = req.query as { noteId?: string; limit?: string };
    const noteId = query.noteId && query.noteId.length > 0 ? query.noteId : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 500)) {
      return reply.code(400).send({ error: "limit 越界（1..500）" });
    }
    const decisions = await withWorkspaceTransaction(ctx, (tx) =>
      listPersonalRelationDecisionsV2(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, noteId, limit }),
    );
    return { decisions };
  });

  /**
   * 记一次表态。
   *
   * §11.3「用户确认首先只影响本人的学习视图；**写入共享关系需具备材料编辑权
   * 并明确作用范围**」——所以这一发**只写本人那一行**，不碰公共 relations、
   * 不碰 lifecycle、不产生任何学习记录或复习安排。
   *
   * **不提供「撤销表态」这一档**：`dismissed` 已经是「我不同意 / 别画给我看」，
   * 那是用户对这条建议的正式意见；再加一个"回到没有意见"的动作，等于让
   * "我确认过"和"我从没表过态"在数据上分不开——而 §11.3 要的正是那两者的区别。
   * 真要撤回一次意见，改一次 `decision` 即可，审计上留得下痕迹。
   */
  app.post("/v3/understanding/relation-decisions", async (req, reply) => {
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    const parsed = setPersonalRelationDecisionV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求形状不对", issues: parsed.error.issues });
    }
    try {
      const result = await withWorkspaceTransaction(ctx, (tx) =>
        setPersonalRelationDecisionV2(tx, {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          fromObjectiveId: parsed.data.fromObjectiveId,
          toObjectiveId: parsed.data.toObjectiveId,
          relation: parsed.data.relation,
          decision: parsed.data.decision,
          ...(parsed.data.noteId ? { noteId: parsed.data.noteId } : {}),
          ...(Object.keys(parsed.data.evidence).length > 0 ? { evidence: parsed.data.evidence } : {}),
          at: new Date(),
        }),
      );
      // 没有变化时回 304：**这不是错误**，而且对幂等重试是对的行为——
      // 用户重复点一次「确认」不该在审计里留两条记录。
      return result.changed ? reply.code(200).send(result) : reply.code(304).send();
    } catch (error) {
      // 两类可解释的拒绝：两端有读不到的、或者自己连自己。
      // 两者都不是"服务端坏了"，所以各说各的话（§11.3 那一句的反面是含糊其辞）。
      if (error instanceof RelationEndpointNotReadableV2) {
        return reply.code(403).send({ error: `relation_endpoint_not_readable:${error.side}` });
      }
      if (error instanceof RelationSelfLoopV2) {
        return reply.code(422).send({ error: "relation_self_loop" });
      }
      throw error;
    }
  });
}
