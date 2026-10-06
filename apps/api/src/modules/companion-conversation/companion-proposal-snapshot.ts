import { sql } from "drizzle-orm";
import { companionProposalSnapshotV1Schema } from "@astella/shared";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { CompanionConversationError } from "./turn/turn-service.ts";

export function snapshotFor(
  proposal: {
    id: string;
    status: string;
    decision: string | null;
    result_ref: string | null;
    result_route: unknown;
    result_safe_summary: string | null;
    payload: { kind: string; [key: string]: unknown };
  },
): unknown {
  const resultRoute = proposal.result_route == null
    ? null
    : typeof proposal.result_route === "string"
      ? (() => {
          try {
            return JSON.parse(proposal.result_route) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : proposal.result_route;
  const route = proposal.status === "succeeded"
    ? navigationRouteFor(proposal.payload.kind, proposal.payload)
    : null;
  return {
    version: 1,
    proposalId: proposal.id,
    status: proposal.status === "accepted" ? "executing" : proposal.status,
    resultRef: proposal.result_ref,
    route: resultRoute ?? route?.route ?? null,
    safeSummary: proposal.result_safe_summary ?? route?.safeSummary ?? null,
  };
}

/** §6.6 reload/cursor-expired recovery for a synchronous proposal. */
export async function getCompanionProposalSnapshot(args: {
  workspaceId: string;
  userId: string;
  proposalId: string;
}): Promise<{ statusCode: 200; body: unknown }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{
        id: string;
        conversation_id: string;
        source_message_id: string;
        source_generation: number;
        context_grant_id: string | null;
        payload: unknown;
        payload_sha256: string;
        title: string;
        target_summary: string;
        impact_summary: string;
        status: string;
        decision: "confirm" | "reject" | null;
        result_ref: string | null;
        result_route: unknown;
        result_safe_summary: string | null;
        expires_at: Date;
        decided_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(sql`
        SELECT p.id, p.conversation_id, p.source_message_id, p.source_generation,
               p.context_grant_id, p.payload, p.payload_sha256, p.title,
               p.target_summary, p.impact_summary, p.status, p.decision,
               p.result_ref, p.result_route, p.result_safe_summary,
               p.expires_at, p.decided_at, p.created_at, p.updated_at
        FROM companion_action_proposals p
        WHERE p.id = ${args.proposalId}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) throw new CompanionConversationError("NOT_FOUND", 404, "proposal not found");
      const parseObject = (value: unknown, field: string): Record<string, unknown> | null => {
        const parsed = typeof value === "string"
          ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
          : value;
        if (parsed == null) return null;
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new CompanionConversationError("INTERNAL_ERROR", 500, `invalid ${field}`);
        }
        return parsed as Record<string, unknown>;
      };
      try {
        const body = companionProposalSnapshotV1Schema.parse({
          version: 1,
          proposal: {
            version: 1,
            proposalId: row.id,
            conversationId: row.conversation_id,
            sourceMessageId: row.source_message_id,
            sourceGeneration: row.source_generation,
            contextGrantId: row.context_grant_id,
            payload: parseObject(row.payload, "proposal payload"),
            payloadSha256: row.payload_sha256,
            title: row.title,
            targetSummary: row.target_summary,
            impactSummary: row.impact_summary,
            requiresConfirmation: true,
            status: row.status,
            decision: row.decision,
            expiresAt: new Date(row.expires_at).toISOString(),
            decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          },
        });
        return { statusCode: 200 as const, body };
      } catch (error) {
        if (error instanceof CompanionConversationError) throw error;
        throw new CompanionConversationError("INTERNAL_ERROR", 500, "invalid proposal snapshot");
      }
    },
  );
}

function navigationRouteFor(kind: string, payload: Record<string, unknown>): {
  route: { kind: string; [k: string]: unknown };
  safeSummary: string;
} | null {
  switch (kind) {
    case "open_review":
      return { route: { kind: "review" }, safeSummary: "打开复习页" };
    case "open_card":
      return typeof payload.cardId === "string" && typeof payload.objectiveId === "string"
        ? {
            route: {
              kind: "card",
              cardId: payload.cardId,
              objectiveId: payload.objectiveId,
            },
            safeSummary: "打开卡片",
          }
        : null;
    case "open_star_map":
      return { route: { kind: "star_map", keyPointId: payload.keyPointId ?? undefined }, safeSummary: "打开星图" };
    case "focus_graph_node":
      return {
        route: { kind: "star_map", keyPointId: payload.keyPointId, lens: payload.lens },
        safeSummary: "聚焦知识节点",
      };
    case "restore_graph_viewport":
      return { route: { kind: "star_map", restoreRun: payload.runId }, safeSummary: "恢复星图视口" };
    case "open_conversation_history":
      return {
        route: { kind: "conversation" },
        safeSummary: "打开对话历史",
      };
    default:
      return null;
  }
}

export async function resolveNavigationRouteFor(
  tx: ApiTransaction,
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<ReturnType<typeof navigationRouteFor>> {
  if (kind !== "open_card") return navigationRouteFor(kind, payload);
  if (typeof payload.cardId !== "string") {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "cardId is required");
  }
  const rows = await tx.execute<{ objective_id: string }>(sql`
    SELECT objective_id
    FROM learning_cards_v2
    WHERE workspace_id = ${workspaceId}
      AND id = ${payload.cardId}
    LIMIT 1
  `);
  const objectiveId = rows[0]?.objective_id;
  if (!objectiveId) {
    throw new CompanionConversationError("NOT_FOUND", 404, "card target no longer exists");
  }
  return navigationRouteFor(kind, { ...payload, objectiveId });
}
