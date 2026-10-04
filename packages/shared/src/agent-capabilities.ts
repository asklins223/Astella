import { z } from "zod";
import { companionAgentToolDefinitionV1Schema } from "./contracts/companion-agent-contracts.ts";
import { createAgentRunV1Schema } from "./contracts/agent-contracts.ts";
import { agentToolParameters } from "./agent-tool-parameters.ts";

function manifest(name: string, description: string, riskClass: "read" | "reversible_low", argumentSchema: z.ZodType<Record<string, unknown>>) {
  return {
    definition: companionAgentToolDefinitionV1Schema.parse({
      version: 1, name, description, riskClass, requiresConfirmation: false,
      toolVersion: "1.0.0", parameters: agentToolParameters(argumentSchema), maxInputChars: 8000, maxOutputChars: 4000,
    }), argumentSchema,
  };
}
const runSchema = z.object({ runId: z.string().uuid(), expectedRevision: z.number().int().positive() });

/** The same capability entry supplies the model description and its argument validator. */
export const agentGoalToolManifest = [
  manifest("agent_start_goal", "把用户当前明确交代的学习目标交给后台持续处理。适合多步整理、速看、互动演示组合；普通闲聊、提问和短句回应不启动。goal 保留本次要求，材料引用从本轮实际读取获取；回执仅代表接受，完成后按真实产物交付。", "reversible_low", createAgentRunV1Schema.omit({ requestId: true, conversationId: true })),
  manifest("agent_list_goals", "读取用户在当前空间交代的持续目标的简短目录；与此刻聊天分开。用户回到上次的任务或问进度时先核对，不能仅凭旧历史猜 runId。", "read", z.object({}).strict()),
  manifest("agent_revise_goal", "用户明确修改某个持续目标时更新要求，旧版本未完成操作会停止，已有产物保留。先核对 runId 和 revision；闲聊或一句好不表示修改。", "reversible_low", runSchema.extend({ goal: z.string().trim().min(1).max(8000) }).strict()),
  manifest("agent_control_goal", "按用户当前明确要求暂停、继续或停止指定持续目标。继续前核对最新版本，不自动重做结果未知的操作；不停止聊天，不删除已有产物。", "reversible_low", runSchema.extend({ action: z.enum(["cancel","pause","resume"]) }).strict()),
] as const;

const noteArgs = z.object({ noteId: z.string().uuid(), noteVersionId: z.string().uuid() }).strict();
export const noteAgentCapabilityManifest = [
  manifest("note_read", "按冻结版本读取一篇实际可见的笔记，获取可核对正文。输入必须来自目标的材料引用；长文返回有界正文与覆盖信息，可用 nextStartOrdinal 继续读。", "read", noteArgs.extend({ startOrdinal: z.number().int().positive().optional() })),
  manifest("note_overview_generate", "生成这版笔记的速看。返回 accepted 与稳定 operationId/jobId；后台返回真实产物后才算完成。不要重复提交同一个产物。", "reversible_low", noteArgs),
  manifest("note_dynamic_artifact_generate", "为这版笔记生成互动讲解演示。返回 accepted 与稳定 operationId/jobId；后台核对产物后才能交付。材料过长或不适合会返回真实失败，不虚构演示。", "reversible_low", noteArgs),
] as const;
