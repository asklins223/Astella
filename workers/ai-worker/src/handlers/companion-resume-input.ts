/**
 * Resuming a step whose model input was interrupted after some text had already
 * been shown.
 *
 * The displayed prefix is authoritative: it reached the user and cannot be
 * withdrawn. If the whole model result can be reused from the step checkpoint,
 * reuse it (so the prefix is not emitted twice). Otherwise the shown suffix is
 * folded into the transcript as a correction, so the model continues instead of
 * restating what the user already read.
 */

import type { AgentTurnRequest } from "@astella/shared";
import { createCompanionAgentStepCheckpointPort } from "./companion-agent-events.ts";
import { companionAgentModelInputHash } from "./companion-agent-task.ts";
import { restoreCompactionCheckpoint } from "./companion-compaction-checkpoint.ts";
import { companionStepCorrectionMessages } from "./companion-step-plan.ts";
import { sanitizeCompanionVisibleText } from "./companion-dialogue-content.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

export interface CompanionResumeInputDeps {
  event: AgentEventContext;
  stepId: string;
  stepRequest: AgentTurnRequest;
  stepProvider: AIProvider;
  permissionLevel: string;
  workspaceId: string;
  userId: string;
  runId: string;
  conversationId: string;
  initialVisibleText: string | undefined;
  visibleSegments: string[];
  visibleSegmentDelivered: boolean[];
  messages: AgentTurnRequest["messages"];
  currentRequest: AgentTurnRequest["messages"][number];
  compactionCheckpoints: readonly unknown[] | undefined;
  separator: string;
  /** Test seam; defaults to the real step-checkpoint table. */
  loadStoredResult?: (input: { stepRequest: AgentTurnRequest }) => Promise<unknown | null>;
}

/**
 * Returns the (possibly rewritten) step request and whether an already
 * delivered prefix means the stored model result may be reused.
 */
export async function resumeCompanionInterruptedInput(
  deps: CompanionResumeInputDeps,
): Promise<{ stepRequest: AgentTurnRequest; reuseStoredResult: boolean }> {
  const displayed = deps.initialVisibleText ?? "";
  const prior = sanitizeCompanionVisibleText(deps.visibleSegments.join(deps.separator));
  if (!(displayed.length > prior.length && displayed.startsWith(prior))) {
    return { stepRequest: deps.stepRequest, reuseStoredResult: false };
  }
  const folded = restoreCompactionCheckpoint({
    runId: deps.runId, conversationId: deps.conversationId,
    request: deps.stepRequest,
    traces: (deps.compactionCheckpoints ?? []) as Parameters<typeof restoreCompactionCheckpoint>[0]["traces"],
  });
  const actualRequest = folded ? { ...deps.stepRequest, messages: folded.messages } : deps.stepRequest;
  const stored = deps.loadStoredResult
    ? await deps.loadStoredResult({ stepRequest: actualRequest })
    : await createCompanionAgentStepCheckpointPort(deps.event, deps.stepId).load({
      taskId: "companion_agent_model_step", taskVersion: 1,
      inputSnapshotHash: companionAgentModelInputHash({
        request: actualRequest, provider: deps.stepProvider, permissionLevel: deps.permissionLevel,
      }),
      workspaceId: deps.workspaceId, userId: deps.userId,
    });
  if (stored) return { stepRequest: deps.stepRequest, reuseStoredResult: true };
  const suffix = displayed.slice(prior.length).replace(/^\n\n/, "");
  deps.visibleSegments.push(suffix);
  deps.visibleSegmentDelivered.push(true);
  deps.messages.push(
    { role: "assistant", content: suffix },
    ...companionStepCorrectionMessages({
      currentRequest: deps.currentRequest,
      alreadyDisplayed: true,
      instruction: "执行进程中断，前面这段文字已经显示；它没有新的工具执行回执。保留已确认结果，接着完成当前问题，不从头重说这段前缀。",
    }),
  );
  return { stepRequest: { ...deps.stepRequest, messages: [...deps.messages] }, reuseStoredResult: false };
}
