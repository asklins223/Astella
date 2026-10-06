import { z } from "zod";
import { knowledgeFormV2Schema } from "@astella/shared/card-generation-v2-contracts";
import { taskIntentSchema } from "@astella/shared/learning-run-contracts";

/** Server-private proposal. A separate grounding check must approve every unit before persistence. */
export const roundTargetDraftSchema = z.strictObject({
  conceptLabel: z.string().trim().min(1).max(200),
  objectiveStatement: z.string().trim().min(1).max(2000),
  publicSummary: z.string().trim().min(1).max(1500),
  knowledgeForm: knowledgeFormV2Schema,
  units: z.array(z.strictObject({
    unitId: z.string().trim().min(1).max(160),
    fact: z.string().trim().min(1).max(4000),
    criterion: z.string().trim().min(1).max(2000),
    facet: taskIntentSchema,
    sourceBlockOrdinal: z.number().int().positive(),
    quote: z.string().min(1).max(8000),
  })).min(1).max(6),
}).superRefine((target, ctx) => {
  if (new Set(target.units.map((unit) => unit.unitId)).size !== target.units.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["units"], message: "target unit ids must be unique" });
  }
});
export type RoundTargetDraft = z.infer<typeof roundTargetDraftSchema>;
