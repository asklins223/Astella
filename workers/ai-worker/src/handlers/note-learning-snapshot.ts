import type { ChatMessage } from "@ailearn/shared";
import { sha256Utf8V1, stableStringify } from "@ailearn/shared/content-hash";

export function noteLearningSnapshotHash(snapshot: {
  taskVersion: number; noteVersionId: string;
  modelId: string; promptVersion: string;
  generationParameters: Record<string, unknown>;
  messages: ChatMessage[];
  [key: string]: unknown;
}): string {
  // Sampling parameters have fractions; the integer-only wire canonicalizer
  // would reject temperatures such as 0.2, 0.25 and 0.35 before the provider is called.
  return sha256Utf8V1(stableStringify(snapshot));
}
