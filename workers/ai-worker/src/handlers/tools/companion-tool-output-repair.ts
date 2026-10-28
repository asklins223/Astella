import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";

/** Correct within the current run, never by replaying the queue job as if no
 * earlier effects or visible text existed. Invalid tool text is not executable. */
export class CompanionToolOutputRepairError extends AgentOutputError {
  readonly draftSha256: string;
  constructor(readonly publishedText: string, draft: string,
    code: "tool_protocol_leak" | "arguments_malformed" | "internal_token_leak" = "tool_protocol_leak") {
    super(code, "companion tool output requires explicit model correction before execution");
    this.name = "CompanionToolOutputRepairError";
    this.draftSha256 = sha256Utf8V1(draft);
  }
}
