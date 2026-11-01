import { createHash } from "node:crypto";
import { uploadObject, usesRemoteStorage } from "../../lib/object-storage.ts";
import type { FastifyInstance } from "fastify";
import { importMarkdownSchema } from "./schema.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { TRANSFER_MAX_BYTES } from "@astella/shared/object-transfer-contracts";
import {
  prepareMarkdownImport,
  importMarkdownNotes,
  finalizeMarkdownImport,
} from "./markdown-import-service.ts";


export async function importRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // POST /import/markdown — 批量导入 Markdown 笔记
  // F-033: 支持幂等键（importId），中途失败时重试不会创建重复笔记
  // G-006: 使用 advisory lock + itemKey 实现并发安全的幂等导入
  // RBAC: 仅 owner 可导入笔记（数据写入操作，member 只读）
  // 导入正文的上限 = 一份正文的上限（`TRANSFER_MAX_BYTES`，100 MB），不再按
  // 「100 items × 500KB」估一个 50MB：一篇长文进来不该被这条估出来的数字拦住。
  app.post("/import/markdown", { preHandler: [requireOwner], bodyLimit: TRANSFER_MAX_BYTES }, async (req) => {
    const body = parseBody(app, importMarkdownSchema, req.body);
    const { workspaceId, userId } = req.session;
    const scope = { workspaceId, userId };
    if (usesRemoteStorage()) {
      const bytes = Buffer.from(JSON.stringify(body));
      const key = `${workspaceId}/imports/${userId}/${createHash("sha256").update(bytes).digest("hex")}.json`;
      await uploadObject(key, bytes, "application/json");
    }

    // 解析/itemKey/图片预注册在业务事务外完成；幂等锁与写入在事务内完成。
    const items = await prepareMarkdownImport(scope, body.items);
    const outcome = await withWorkspaceTransaction(scope, (tx) =>
      importMarkdownNotes(tx, scope, { items, importId: body.importId ?? null }));
    // 搜索索引是可重建投影，事务提交后再刷新。
    return finalizeMarkdownImport(outcome);
  });
}
