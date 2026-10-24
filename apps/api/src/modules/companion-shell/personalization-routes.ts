import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { userLearningPreferences } from "@astella/shared/db-schema/companion";
import { COMPANION_PREFERRED_ADDRESS_KEY, companionPersonalizationWriteV1Schema } from "@astella/shared/companion-shell-contracts";
import { withWorkspaceTransaction, scopeOfSession } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";

const ADDRESS_REVISION = "companion_address_revision";
type Preferences = Record<string, unknown>;
function addressState(value: Preferences) {
  const address = value[COMPANION_PREFERRED_ADDRESS_KEY];
  return { version: 1 as const, revision: Number(value[ADDRESS_REVISION]) || 0,
    preferredAddress: typeof address === "string" && address.trim() ? address : null };
}

/// 账号级私下称呼：GET 读数，PUT 以 revision CAS 写入；独立于公开昵称与伴星 persona。
/// 2026-10-24：随首次相伴引导示例删除，`/me/companion/first-journey` 已移除，这里只保留真实设置。
export async function companionPersonalizationRoutes(app: FastifyInstance) {
  app.get("/me/companion/personalization", { preHandler: [requireSession] }, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const scope = scopeOfSession(req.session);
    return withWorkspaceTransaction(scope, async tx => {
      const [row] = await tx.select({ preferences: userLearningPreferences.explicitPreferences }).from(userLearningPreferences)
        .where(and(eq(userLearningPreferences.userId, scope.userId), sql`${userLearningPreferences.workspaceId} IS NULL`)).limit(1);
      return addressState(row?.preferences ?? {});
    });
  });

  app.put("/me/companion/personalization", { preHandler: [requireSession] }, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const scope = scopeOfSession(req.session);
    const body = parseBody(app, companionPersonalizationWriteV1Schema, req.body);
    return withWorkspaceTransaction(scope, async tx => {
      // Insert-if-absent before taking the row lock also serializes first writes
      // with TTS/preferences on the same partial account-unique index.
      await tx.insert(userLearningPreferences).values({ userId: scope.userId, explicitPreferences: {}, suggestedPreferences: {} }).onConflictDoNothing();
      const [row] = await tx.select().from(userLearningPreferences)
        .where(and(eq(userLearningPreferences.userId, scope.userId), sql`${userLearningPreferences.workspaceId} IS NULL`)).for("update");
      if (!row) throw new Error("Account preferences row unavailable");
      const preferences = { ...row.explicitPreferences };
      const current = addressState(preferences);
      if (current.revision !== body.revision) return reply.code(409).send({ error: "STALE_REVISION", message: "称呼已在另一台设备更新，请重新读取后保存。", current });
      const next = { version: 1 as const, preferredAddress: body.preferredAddress, revision: current.revision + 1 };
      preferences[COMPANION_PREFERRED_ADDRESS_KEY] = next.preferredAddress;
      preferences[ADDRESS_REVISION] = next.revision;
      await tx.update(userLearningPreferences).set({ explicitPreferences: preferences, updatedAt: new Date() }).where(eq(userLearningPreferences.id, row.id));
      return next;
    });
  });
}
