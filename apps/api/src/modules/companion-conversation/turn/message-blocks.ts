import { z } from "zod";
import { companionContentBlockV1Schema, type CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";

const blocksSchema = z.array(companionContentBlockV1Schema).min(1).max(32);

/** Old stored action envelopes and text discriminators are read as the same
 * real blocks. All current writers already store the canonical array. */
export function readStoredCompanionBlocks(stored: unknown): CompanionContentBlockV1[] {
  const value = stored && typeof stored === "object" && !Array.isArray(stored) && "blocks" in stored ? stored.blocks : stored;
  const normalized = Array.isArray(value) ? value.map(block => {
    if (block && typeof block === "object" && !("type" in block) && "kind" in block && block.kind === "text" && "text" in block) return { type: "text", text: block.text };
    return block;
  }) : value;
  return blocksSchema.parse(normalized);
}
