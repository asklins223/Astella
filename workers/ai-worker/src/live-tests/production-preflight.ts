/** Production probes must not claim to exercise retired runtime experiments. */
export function assertProductionProbeConfiguration(env: Record<string, string | undefined>): void {
  const retired = [
    "COMPANION_DIALOGUE_FRAME_V1",
    "COMPANION_DIALOGUE_REVIEW_V1",
    "COMPANION_EXPLANATION_REVIEW_V1",
  ].filter((name) => env[name] === "true");
  if (retired.length) {
    throw new Error(`${retired.join(", ")} no longer enables a production branch; use the offline diagnostic probes.`);
  }
}
