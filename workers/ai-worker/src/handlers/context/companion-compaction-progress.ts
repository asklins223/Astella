import { sql } from "drizzle-orm";
import type { AgentTurnRequest } from "@astella/shared";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import { lockCompanionRunForEventWrite } from "@astella/shared/companion-lock-order";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../../db.ts";
import { lockJobLease, JobLeaseLostError } from "../../lib/job-lease.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { logger } from "../../lib/logger.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import { assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
import { companionSemanticCheckpointSchema, type CompanionSemanticCheckpointStore } from "./companion-semantic-checkpoint.ts";

/** One cumulative state per source kind on the private running step, independent
 * of the model-result checkpoint. No source body is duplicated per part. */
export function createCompanionCompactionProgressStore(input: {
  event: Pick<AgentEventContext, "ctx"> & { read: Pick<AgentEventContext["read"],
    "runId" | "conversationId" | "userId" | "generation" | "accountEpoch"> };
  stepId: string; request: AgentTurnRequest; provider: AIProvider;
  sourceKind: "history_exchanges" | "active_tool_rounds";
}): CompanionSemanticCheckpointStore {
  const { event, stepId, sourceKind, provider } = input;
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  const key = { ...scope, runId: event.read.runId, conversationId: event.read.conversationId, stepId,
    requestSha256: sha256Utf8V1(stableStringify(input.request)), sourceKind };
  const transaction = async <T>(run: (tx: WorkerTransaction) => Promise<T>): Promise<T> => {
    try {
      return await withWorkerWorkspaceTransaction(scope, async tx => {
        await lockCompanionRunForEventWrite(tx, event.read.runId);
        await lockJobLease(tx, event.ctx);
        await assertCompanionContextSourcesCurrent(tx, scope, event.read.runId);
        const [active] = await tx.execute(sql`SELECT r.id FROM companion_turn_runs r
          JOIN user_companion_account_state a ON a.user_id=r.user_id
          WHERE r.id=${event.read.runId} AND r.workspace_id=${scope.workspaceId} AND r.user_id=${scope.userId}
            AND r.status IN ('accepted','running') AND r.generation=${event.read.generation}
            AND r.account_epoch=${event.read.accountEpoch} AND a.epoch=r.account_epoch AND a.global_enabled`);
        if (!active) throw new CompanionContextChangedError();
        return run(tx);
      });
    } catch (error) {
      if (error instanceof JobLeaseLostError || error instanceof CompanionContextChangedError) throw error;
      // Driver errors can include the private summary in SQL bind parameters.
      // Do not attach a cause or expose that payload to ordinary job logging.
      const unavailable = new Error("companion source checkpoint storage unavailable");
      unavailable.name = "CompanionSourceCheckpointStorageError";
      throw unavailable;
    }
  };
  return {
    contract: { providerId: provider.id, modelId: provider.modelId, promptVersion: provider.promptVersion,
      capability: provider.getCapabilities?.() ?? null },
    load: () => transaction(async tx => {
      const [row] = await tx.execute<{ value: { key?: unknown; state?: unknown } | null }>(sql`
        SELECT compaction_checkpoint->${sourceKind} AS value FROM companion_agent_steps
        WHERE id=${stepId} AND run_id=${event.read.runId} AND workspace_id=${scope.workspaceId}
          AND user_id=${scope.userId} AND status='running'`);
      const stored = row?.value;
      return stored && stableStringify(stored.key) === stableStringify(key) ? stored.state : null;
    }),
    save: async state => {
      const stored = { key, state: companionSemanticCheckpointSchema.parse(state) };
      await transaction(async tx => {
        const [saved] = await tx.execute(sql`UPDATE companion_agent_steps
          SET compaction_checkpoint=jsonb_set(coalesce(compaction_checkpoint,'{}'::jsonb),
            ARRAY[${sourceKind}],${JSON.stringify(stored)}::jsonb,true)
          WHERE id=${stepId} AND run_id=${event.read.runId} AND workspace_id=${scope.workspaceId}
            AND user_id=${scope.userId} AND status='running' RETURNING id`);
        if (!saved) throw new CompanionContextChangedError();
      });
    },
    onResume: progress => logger.info({ runId: event.read.runId, stepId, sourceKind, ...progress },
      "resumed partial complete-source compaction"),
  };
}
