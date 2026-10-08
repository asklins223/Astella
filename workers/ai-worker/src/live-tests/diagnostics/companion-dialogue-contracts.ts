/** Retired experiment schemas, used only by recorded diagnostics. */
import { z } from "zod";

/** Dialogue interpretation is not execution authority. Facts remain literal user testimony. */
export const agentDialoguePurposeV1Schema = z.enum([
  "greeting", "sharing", "venting", "seeking_help", "correction", "preference", "factual_question", "other",
]);
const dialogueSourceProposal = z.object({
  messageIndex: z.number().int().nonnegative(), quote: z.string().min(1).max(320).refine(value=>value.trim().length>0),
}).strict();
const dialogueSource = dialogueSourceProposal.extend({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) });
const dialogueStateFields = {
  topic: z.string().trim().min(1).max(80),
  aspect: z.enum(["progress", "timing", "preference", "decision", "other"]),
  relation: z.enum(["statement", "correction"]),
  relevance: z.enum(["foreground","background"]).optional(),
  /** Interpretation of the cited testimony, not an independently verified event. */
  progress: z.object({
    work: z.enum(["not_started","in_progress","completed","unknown"]),
    handoff: z.enum(["not_handed_off","handed_off","unknown"]),
  }).strict().optional(),
};
export const agentDialogueFrameProposalV1Schema = z.object({
  purpose: agentDialoguePurposeV1Schema,
  evidence: dialogueSourceProposal,
  userState: z.array(dialogueSourceProposal.extend(dialogueStateFields)).max(6),
}).strict();
export const agentDialogueFrameV1Schema = z.object({
  purpose: agentDialoguePurposeV1Schema,
  evidence: dialogueSource,
  userState: z.array(dialogueSource.extend(dialogueStateFields)).max(6),
}).strict();
export type AgentDialogueFrameV1 = z.infer<typeof agentDialogueFrameV1Schema>;
