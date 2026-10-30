import type { AgentTurnRequest } from "@astella/shared";
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import { updateRunMeta } from "../agent/companion-agent-events.ts";
import { startCompanionAttention, type CompanionEntryMode } from "./companion-entry-mode.ts";
import { resolveCompanionTurnWorkload } from "./companion-turn-workload.ts";

/** A speculative model call has no tool effects or public output before settle.
 * The ordinary ledger/checkpoint runner owns both the discarded and kept call. */
export function createCompanionEntrySettlement(input: {
  args: CompanionAgentLoopArgs; event: AgentEventContext; mode: CompanionEntryMode;
  requestHash: string; cached: AgentTurnInterpretationV1 | null;
  messages: AgentTurnRequest["messages"]; writingAnnotation: boolean;
  requiresGrounding: boolean; recovered: boolean;
}, commit: typeof updateRunMeta = updateRunMeta) {
  const started = startCompanionAttention({ args: input.args, requestHash: input.requestHash,
    cached: input.cached, preserveHostInterpretation: input.writingAnnotation });
  const { attention } = started;
  let settlement: Promise<AgentTurnInterpretationV1> | undefined;
  const workload = () => resolveCompanionTurnWorkload({ mode: input.mode, attention,
    requiresGrounding: input.requiresGrounding });
  return {
    attention,
    speculative: false,
    get workload() { return workload(); },
    settle() {
      return settlement ??= (async () => {
        await started.settled;
        await commit(input.event, { turnInterpretation: attention,
          route: { version: 1, entryMode: input.mode, workload: workload() } });
        return attention;
      })();
    },
  };
}
