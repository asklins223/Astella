/** Scope is explicit metadata. Natural-language subjects and reference words
 * cannot authorize cross-space use or veto a user's account preference. */
export function memoryScopeForKind(
  kind: string,
  modelScope?: string,
  binding?: string,
): "global" | "workspace" | "task" {
  // Only preferences can follow the account. Missing/uncertain binding stays
  // local; subject names in the content do not change this decision.
  if (kind === "preference") return binding === "portable" ? "global" : "workspace";
  return modelScope === "task" ? "task" : "workspace";
}

export type AccountPreferenceWriteRejection = "kind_not_preference";

/** API callers explicitly select the scope; extraction uses the semantic
 * binding above. Both paths still enforce ownership and propagation policy. */
export function accountPreferenceWriteDecision(input: {
  scope?: string | null;
  kind: string;
  content: string;
  appliesWhen?: string | null;
}): { ok: true } | { ok: false; reason: AccountPreferenceWriteRejection } {
  return input.scope === "global" && input.kind !== "preference"
    ? { ok: false, reason: "kind_not_preference" }
    : { ok: true };
}

export function accountPreferenceRejectionMessage(_reason: AccountPreferenceWriteRejection): string {
  return "只有「关于你一贯怎么学、怎么相处」的偏好可以设为账号级（跨空间），这条请留在当前书房单独保存。";
}
