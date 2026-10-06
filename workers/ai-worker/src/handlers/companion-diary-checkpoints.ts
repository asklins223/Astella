import { sql } from "drizzle-orm";
import type {
  AiCheckpointEntry,
  AiCheckpointKey,
  AiTaskCheckpointPort,
} from "@astella/shared/ai-task-kernel";
import { lockJobLease, withJobTransaction, type JobLeaseContext } from "../lib/job-lease.ts";

/**
 * Durable output for one diary stage. A checkpoint is usable only by the job,
 * workspace, user, task version, and source snapshot that produced it.
 */
export function createDiaryCheckpointPort<TOutput>(input: {
  job: JobLeaseContext;
  userId: string;
  personaVersion?: { profileRevision: number; examplesRevision: number; defaultExpressionVersion: string };
  parseOutput(value: unknown): TOutput | null;
}): AiTaskCheckpointPort<TOutput> {
  return {
    load: async (key: AiCheckpointKey): Promise<AiCheckpointEntry<TOutput> | null> => {
      if (key.workspaceId !== input.job.workspaceId || key.userId !== input.userId) return null;
      const rows = await withJobTransaction(input.job, (tx) => tx.execute<{
        output: unknown;
        prompt_tokens: number;
        completion_tokens: number;
        persona_profile_revision: number | null;
        persona_examples_revision: number | null;
        default_expression_version: string | null;
      }>(sql`
        SELECT output, prompt_tokens, completion_tokens,
               persona_profile_revision, persona_examples_revision, default_expression_version
        FROM companion_diary_generation_checkpoints
        WHERE job_id = ${input.job.id} AND workspace_id = ${key.workspaceId} AND user_id = ${input.userId}
          AND task_id = ${key.taskId} AND task_version = ${key.taskVersion}
          AND input_snapshot_hash = ${key.inputSnapshotHash}
        LIMIT 1
      `));
      const row = (Array.isArray(rows) ? rows : [])[0];
      if (!row) return null;
      if (input.personaVersion && (
        row.persona_profile_revision !== input.personaVersion.profileRevision
        || row.persona_examples_revision !== input.personaVersion.examplesRevision
        || row.default_expression_version !== input.personaVersion.defaultExpressionVersion
      )) return null;
      const output = input.parseOutput(row.output);
      if (output === null) return null;
      return {
        output,
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
      };
    },
    save: async (key: AiCheckpointKey, entry: AiCheckpointEntry<TOutput>): Promise<void> => {
      if (key.workspaceId !== input.job.workspaceId || key.userId !== input.userId) {
        throw new Error("diary checkpoint scope does not match its job");
      }
      await withJobTransaction(input.job, async (tx) => {
        await lockJobLease(tx, input.job);
        await tx.execute(sql`
          INSERT INTO companion_diary_generation_checkpoints
            (job_id, workspace_id, user_id, task_id, task_version, input_snapshot_hash,
             output, prompt_tokens, completion_tokens, persona_profile_revision,
             persona_examples_revision, default_expression_version, created_at)
          VALUES (${input.job.id}, ${key.workspaceId}, ${input.userId}, ${key.taskId}, ${key.taskVersion},
                  ${key.inputSnapshotHash}, ${JSON.stringify(entry.output)}::jsonb,
                  ${entry.promptTokens}, ${entry.completionTokens},
                  ${input.personaVersion?.profileRevision ?? null},
                  ${input.personaVersion?.examplesRevision ?? null},
                  ${input.personaVersion?.defaultExpressionVersion ?? null}, now())
          ON CONFLICT (job_id, task_id, task_version, input_snapshot_hash)
          DO UPDATE SET output = EXCLUDED.output,
                        prompt_tokens = EXCLUDED.prompt_tokens,
                        completion_tokens = EXCLUDED.completion_tokens,
                        persona_profile_revision = EXCLUDED.persona_profile_revision,
                        persona_examples_revision = EXCLUDED.persona_examples_revision,
                        default_expression_version = EXCLUDED.default_expression_version,
                        created_at = now()
        `);
      });
    },
  };
}
