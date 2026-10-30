/**
 * Assembling the turn's starting transcript and the recovery identity.
 *
 * The identity is what makes a resumed step continue the same work instead of
 * replaying a different one: provider, model, tool versions, permissions and the
 * frozen dialogue all take part. Both pieces belong together because the
 * identity is computed from exactly the transcript this module builds.
 */

import type { AgentTurnRequest } from "@astella/shared";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import { recentOwnLines, renderCompanionInitiativeObservation } from "../proactive/companion-initiative-observation.ts";

type AgentMessage = AgentTurnRequest["messages"][number];

export interface CompanionTurnOpening {
  readonly dialogueHistory: AgentMessage[];
  /** The initiative observation, appended after the frozen dialogue. */
  readonly initiativeObservation: AgentMessage | null;
  /** The request this turn answers: the host observation or the last user turn. */
  readonly currentRequest: AgentMessage;
  readonly messages: AgentMessage[];
}

/**
 * Preserve host-origin historical records through the same path as completed
 * native exchanges. They close no fabricated assistant turn and create no new
 * human request; their original source remains in the handoff and database.
 *
 * `reasoning` travels with assistant history: in thinking mode the gateway treats
 * a request that ends on an assistant turn as a continuation and demands that
 * turn's `reasoning_text` back. Initiative turns always have that shape, so
 * dropping it is a 400 on every turn (0435; `encrypted_content` alone is not enough).
 */
export function openCompanionTurn(args: CompanionAgentLoopArgs): CompanionTurnOpening {
  const dialogueHistory = args.baseMessages
    .filter((message) => message.role !== "system" || message.hostObservation)
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.hostObservation ? { hostObservation: true } : {}),
      ...(message.reasoning && message.reasoning.length > 0 ? { reasoning: message.reasoning } : {}),
    } as AgentMessage));
  const initiativeObservation = args.read.initiativeInput
    ? {
      role: "system" as const, hostObservation: true as const,
      content: renderCompanionInitiativeObservation(args.read.initiativeInput,
        { lastOwnLines: recentOwnLines(dialogueHistory) }),
    } as AgentMessage
    : null;
  const currentRequest = initiativeObservation
    ?? [...dialogueHistory].reverse().find((message) => message.role === "user" && !message.hostObservation);
  if (!currentRequest) throw new Error("companion turn is missing its current user request");
  currentRequest.requestBoundary = true;
  const messages = initiativeObservation ? [...dialogueHistory, initiativeObservation] : [...dialogueHistory];
  return { dialogueHistory, initiativeObservation, currentRequest, messages };
}

/** The frozen identity a checkpoint must match to continue this run. */
export function companionRecoveryIdentity(input: {
  args: CompanionAgentLoopArgs;
  currentRequest: AgentMessage;
  permissionLevel: string;
  definitions: readonly { name: string; toolVersion: string; parameters: unknown }[];
  primary: { id: string; modelId: string; promptVersion: string;
    getCapabilities?: () => unknown };
  fallback: { id: string; modelId: string; promptVersion: string } | null;
}) {
  return {
    version: 1,
    runId: input.args.read.runId,
    conversationId: input.args.read.conversationId,
    baseMessages: input.args.baseMessages,
    currentRequest: input.currentRequest,
    permissionLevel: input.permissionLevel,
    definitions: input.definitions.map(({ name, toolVersion, parameters }) => ({ name, toolVersion, parameters })),
    provider: {
      id: input.primary.id, modelId: input.primary.modelId, promptVersion: input.primary.promptVersion,
      capability: input.primary.getCapabilities?.() ?? null,
    },
    fallback: input.fallback
      ? { id: input.fallback.id, modelId: input.fallback.modelId, promptVersion: input.fallback.promptVersion }
      : null,
  };
}
