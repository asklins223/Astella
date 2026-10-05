import { z } from "zod";
import { createNoteOverviewTaskV1Schema } from "./note-overview-contracts.ts";
import { createNoteDynamicArtifactTaskV1Schema } from "./note-learning-artifact-contracts.ts";
import { createNoteExpansionTaskV1Schema } from "./note-expansion-contracts.ts";
import { createCardGenerationRunRequestV2Schema } from "./card-generation-v2-contracts.ts";

/** A domain button supplies the real domain request. It does not ask a model
 * to reconstruct options/selection, or grant them to later conversation turns. */
export const agentDirectRequestV1Schema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("note_overview_generate"), noteId: z.string().uuid(), request: createNoteOverviewTaskV1Schema }).strict(),
  z.object({ capability: z.literal("note_dynamic_artifact_generate"), noteId: z.string().uuid(), request: createNoteDynamicArtifactTaskV1Schema }).strict(),
  z.object({ capability: z.literal("note_expansion_generate"), noteId: z.string().uuid(), request: createNoteExpansionTaskV1Schema }).strict(),
  z.object({ capability: z.literal("card_generation_generate"), noteId: z.string().uuid(), request: createCardGenerationRunRequestV2Schema }).strict(),
]);
export type AgentDirectRequestV1 = z.infer<typeof agentDirectRequestV1Schema>;
