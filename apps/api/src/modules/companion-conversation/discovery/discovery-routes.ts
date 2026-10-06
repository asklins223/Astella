/**
 * 40 §7 发现簿的 HTTP 面。
 *
 * 四个动作：收藏 / 取消收藏 / 改批注 / 读簿子。加一个"这一份内容收藏了没有"，
 * 因为**笔记旁那一侧**要显示"已收藏"，而它拿的是同一份身份（§7「共用收藏身份」）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireSession } from "../../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction, type ApiTransaction } from "../../../db/client.ts";
import {
  COMPANION_DISCOVERY_KINDS,
  COMPANION_DISCOVERY_SOURCES,
  COMPANION_DISCOVERY_VISIBILITY,
  companionDiscoveryBookV1Schema,
} from "@astella/shared/companion-discovery-contracts";
import {
  annotateEntry,
  collectEntry,
  collectionState,
  listEntries,
  uncollectEntry,
  type DiscoveryScope,
} from "./discovery-service.ts";

const uuidish = z.string().min(1).max(200);
const metaSchema = z.object({ requestId: z.string().optional(), workspaceEpoch: z.number().optional() });

const collectBody = z.strictObject({
  meta: metaSchema,
  request: z.strictObject({
    kind: z.enum(COMPANION_DISCOVERY_KINDS),
    source: z.enum(COMPANION_DISCOVERY_SOURCES),
    sourceId: uuidish,
    author: z.enum(["user", "assistant"]),
    body: z.string().min(1).max(4000),
    annotation: z.string().max(2000).nullable().optional(),
    // 缺省即 private（§7「私人内容默认不跨空间、跨成员展示」）。
    visibility: z.enum(COMPANION_DISCOVERY_VISIBILITY).optional(),
  }),
});

const identityBody = z.strictObject({
  meta: metaSchema,
  request: z.strictObject({
    kind: z.enum(COMPANION_DISCOVERY_KINDS),
    source: z.enum(COMPANION_DISCOVERY_SOURCES),
    sourceId: uuidish,
  }),
});

const annotateBody = z.strictObject({
  meta: metaSchema,
  request: z.strictObject({ entryId: z.string().uuid(), annotation: z.string().max(2000).nullable() }),
});

function scopeOf(req: { session?: unknown }): DiscoveryScope {
  const session = req.session as { workspaceId: string; userId: string };
  return { workspaceId: session.workspaceId, userId: session.userId };
}

export async function companionDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  /** 簿子页。没有收藏就是空的（§7「没有收藏时保持清爽，不生成假内容」）。 */
  app.get("/companion/discovery", { preHandler: [requireSession] }, async (req, reply) => {
    const scope = scopeOf(req);
    const result = await withWorkspaceTransaction(scopeOfSession(req.session as never), async (tx: ApiTransaction) =>
      listEntries(tx, scope),
    );
    return reply.header("Cache-Control", "no-store")
      .send(companionDiscoveryBookV1Schema.parse({ version: 1, entries: result.entries, studyVisible: result.studyVisible }));
  });

  app.post("/companion/discovery", { preHandler: [requireSession] }, async (req, reply) => {
    const parsed = collectBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: parsed.error.issues.map((i) => i.path.join(".")).join(",") });
    }
    const scope = scopeOf(req);
    const out = await withWorkspaceTransaction(scopeOfSession(req.session as never), async (tx: ApiTransaction) =>
      collectEntry(tx, scope, parsed.data.request),
    );
    if (out.status === "rejected") {
      if (out.reason === "source_unavailable") return reply.code(404).send({ error: "not_found", message: "原日记或收藏时的版本当前不可访问" });
      // 作者标错、来源不对、书房超限都在这里挡下，并如实说明是哪一条。
      return reply.code(422).send({ error: out.reason, message: "这一条不能放进发现簿" });
    }
    // already_collected 也回 200：重复收藏不是错误，而"它本来就在那里"是答案。
    return reply.code(out.status === "collected" ? 201 : 200).send({ status: out.status, entry: out.entry });
  });

  /**
   * 取消收藏。只置不可见，**不动原始回答与日记**（§7）。
   *
   * 用 POST 而不是 DELETE：这个动作**不是删除**，叫 delete 会让下一次有人
   * 顺手把它接成级联。
   */
  app.post("/companion/discovery/uncollect", { preHandler: [requireSession] }, async (req, reply) => {
    const parsed = identityBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: parsed.error.issues.map((i) => i.path.join(".")).join(",") });
    }
    const scope = scopeOf(req);
    const out = await withWorkspaceTransaction(scopeOfSession(req.session as never), async (tx: ApiTransaction) =>
      uncollectEntry(tx, scope, parsed.data.request),
    );
    return reply.header("Cache-Control", "no-store").send(out);
  });

  app.post("/companion/discovery/annotate", { preHandler: [requireSession] }, async (req, reply) => {
    const parsed = annotateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: parsed.error.issues.map((i) => i.path.join(".")).join(",") });
    }
    const scope = scopeOf(req);
    const out = await withWorkspaceTransaction(scopeOfSession(req.session as never), async (tx: ApiTransaction) =>
      annotateEntry(tx, scope, parsed.data.request),
    );
    if (out.status === "not_found") return reply.code(404).send({ error: "not_found", message: "簿子里没有这一条" });
    return reply.header("Cache-Control", "no-store").send(out);
  });

  /** 笔记旁那一侧问"这一份收藏了没有" —— 同一份身份，两处同步。 */
  app.get("/companion/discovery/state", { preHandler: [requireSession] }, async (req, reply) => {
    const query = identityBody.shape.request.safeParse(req.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", message: query.error.issues.map((i) => i.path.join(".")).join(",") });
    }
    const scope = scopeOf(req);
    const out = await withWorkspaceTransaction(scopeOfSession(req.session as never), async (tx: ApiTransaction) =>
      collectionState(tx, scope, query.data),
    );
    return reply.header("Cache-Control", "no-store").send(out);
  });
}
